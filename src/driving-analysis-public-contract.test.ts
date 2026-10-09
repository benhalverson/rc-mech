import { afterEach, describe, expect, test, vi } from 'vitest';
import { DrivingAnalysisAuthority } from './driving-analysis/analysis/driving-analysis-authority';
import { CornerClipAuthority } from './driving-analysis/clips/corner-clip-authority';
import { createHonoFixture } from './testing/hono-fixture';

const root = '/api/v1/driving-analyses/66666666-6666-4666-8666-666666666666';
const contracts = [
	[root, 'delete'],
	[`${root}/lifecycle`, 'get'],
	[`${root}/cancel`, 'post'],
	[`${root}/retry`, 'post'],
	[`${root}/reidentification`, 'get'],
	[`${root}/reidentification`, 'post'],
	[`${root}/clips`, 'get'],
	[`${root}/clips/77777777-7777-4777-8777-777777777777/content`, 'get'],
	[`${root}/clips/77777777-7777-4777-8777-777777777777/content`, 'head'],
] as const;

/** Fetch the published contract through the composed public Worker app. */
async function publishedPaths() {
	const { request } = createHonoFixture();
	const response = await request('/api/openapi.json');
	expect(response.status).toBe(200);
	return (await response.json()) as {
		paths: Record<
			string,
			Record<
				string,
				{
					requestBody?: {
						content: {
							'application/json': {
								schema: {
									required: string[];
									additionalProperties: boolean;
									properties: Record<string, unknown>;
								};
							};
						};
					};
					responses: Record<string, unknown>;
				}
			>
		>;
	};
}

afterEach(() => vi.restoreAllMocks());

describe('Driving-analysis public contract parity', () => {
	test.each(contracts)(
		'publishes and authenticates %s %s',
		async (path, method) => {
			const { paths } = await publishedPaths();
			const documentedPath = path
				.replace(/66666666-6666-4666-8666-666666666666/, '{analysisId}')
				.replace(/77777777-7777-4777-8777-777777777777/, '{clipId}');
			expect(paths[documentedPath]?.[method]?.responses).toHaveProperty('401');
			const { request, d1, analysisMedia } = createHonoFixture(false);
			expect(
				(await request(path, { method: method.toUpperCase() })).status,
			).toBe(401);
			d1.expectConsumed();
			expect(analysisMedia.objects.size).toBe(0);
		},
	);

	test('publishes optional retry command identity and strict revision mutations', async () => {
		const { paths } = await publishedPaths();
		const retry =
			paths['/api/v1/driving-analyses/{analysisId}/retry'].post.requestBody
				?.content['application/json'].schema;
		expect(retry?.required).toEqual(['expectedStateVersion']);
		expect(retry?.properties.commandId).toMatchObject({
			type: 'string',
			format: 'uuid',
		});
		for (const [path, method] of [
			[root, 'DELETE'],
			[`${root}/cancel`, 'POST'],
			[`${root}/retry`, 'POST'],
			[`${root}/reidentification`, 'POST'],
		]) {
			const { request, d1 } = createHonoFixture();
			const response = await request(path, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ expectedStateVersion: 1, extra: true }),
			});
			expect(response.status).toBe(400);
			expect(await response.json()).toHaveProperty('error');
			d1.expectConsumed();
		}
	});

	test.each(['reidentification', 'clips', 'clips/clip-id/content'])(
		'keeps missing owned %s private through the app',
		async (suffix) => {
			const { request, d1 } = createHonoFixture();
			d1.queue({ kind: 'first', value: null });
			const response = await request(`${root}/${suffix}`);
			expect(response.status).toBe(404);
			expect(await response.json()).toHaveProperty('error');
			if (suffix.startsWith('clips'))
				expect(response.headers.get('cache-control')).toBe('private, no-store');
			d1.expectConsumed();
			expect(d1.queries[0].values).toContain('owner-1');
		},
	);

	test('forwards valid retry identity and publishes lifecycle mutation envelopes', async () => {
		const lifecycle = {
			analysisId: root.split('/').at(-1) ?? '',
			status: 'deleted' as const,
			stateVersion: 3,
			permanent: true,
			canCancel: false,
			canRetry: false,
			failure: null,
		};
		const get = vi.fn(async () => lifecycle);
		const remove = vi.fn(async () => lifecycle);
		const authority = new DrivingAnalysisAuthority(createHonoFixture().env.DB);
		const retry = vi.spyOn(authority, 'retry').mockResolvedValue({
			analysis: {} as Awaited<ReturnType<DrivingAnalysisAuthority['get']>>,
			retried: false,
		});
		const cancel = vi
			.spyOn(authority, 'cancel')
			.mockResolvedValue(
				{} as Awaited<ReturnType<DrivingAnalysisAuthority['get']>>,
			);
		const { request, d1 } = createHonoFixture({
			drivingAnalysisAuthority: () => authority,
			analysisLifecycle: () => ({ get, remove, cleanup: async () => [] }),
		});
		const receipt = await request(`${root}/lifecycle`);
		expect(receipt.status).toBe(200);
		expect(await receipt.json()).toEqual({ lifecycle });
		expect(get).toHaveBeenCalledWith('owner-1', lifecycle.analysisId);
		const commandId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
		for (const [path, method, body, envelope] of [
			[
				`${root}/retry`,
				'POST',
				{ expectedStateVersion: 2, commandId },
				'drivingAnalysis',
			],
			[
				`${root}/cancel`,
				'POST',
				{ expectedStateVersion: 2 },
				'drivingAnalysis',
			],
			[root, 'DELETE', { expectedStateVersion: 2 }, 'lifecycle'],
		] as const) {
			const response = await request(path, {
				method,
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(body),
			});
			expect(response.status).toBe(202);
			expect(await response.json()).toEqual({
				[envelope]: envelope === 'lifecycle' ? lifecycle : {},
			});
		}
		expect(retry).toHaveBeenCalledWith(
			'owner-1',
			lifecycle.analysisId,
			2,
			commandId,
		);
		expect(cancel).toHaveBeenCalledWith('owner-1', lifecycle.analysisId, 2);
		expect(remove).toHaveBeenCalledWith({
			ownerId: 'owner-1',
			analysisId: lifecycle.analysisId,
			expectedStateVersion: 2,
		});
		d1.expectConsumed();
	});

	test.each(['deleting', 'deleted'])(
		'documents permanent private clip denial for %s',
		async (status) => {
			const { request, d1 } = createHonoFixture();
			d1.queue({
				kind: 'first',
				value: { id: 'analysis-id', ownerId: 'owner-1', status },
			});
			const response = await request(`${root}/clips`);
			expect(response.status).toBe(410);
			expect(await response.json()).toEqual({ error: 'DELETED' });
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			d1.expectConsumed();
		},
	);

	test.each([
		['GET', undefined, undefined, 200, 'abcdefgh'],
		['GET', 'bytes=2-4', undefined, 206, 'cde'],
		['HEAD', 'bytes=-2', undefined, 206, ''],
		['GET', 'bytes=0-1,3-4', undefined, 416, ''],
		['GET', 'bytes=8-', undefined, 416, ''],
		['GET', 'bytes=0-1', '"stale"', 200, 'abcdefgh'],
		['GET', undefined, 'not-modified', 304, ''],
		['HEAD', undefined, 'precondition-failed', 412, ''],
	] as const)(
		'honors published playback %s %s %s',
		async (method, range, ifRange, status, body) => {
			const { paths } = await publishedPaths();
			const operation =
				paths['/api/v1/driving-analyses/{analysisId}/clips/{clipId}/content'][
					method.toLowerCase()
				];
			expect(operation.responses).toHaveProperty(String(status));
			const { request, analysisMedia, d1 } = createHonoFixture();
			const stored = await analysisMedia.bucket.put('private-key', 'abcdefgh', {
				customMetadata: { sha256: 'a'.repeat(64) },
			});
			const readObject = analysisMedia.bucket.get.bind(analysisMedia.bucket);
			const getObject = vi
				.spyOn(analysisMedia.bucket, 'get')
				.mockImplementation(async (key, options) => {
					const object = await readObject(key, options);
					if (!object || !('body' in object)) return object;
					const bytes = new Uint8Array(await object.arrayBuffer());
					const requested = options?.range;
					const sliced =
						requested && 'offset' in requested && 'length' in requested
							? bytes.slice(
									requested.offset,
									(requested.offset ?? 0) + (requested.length ?? bytes.length),
								)
							: bytes;
					return {
						...object,
						writeHttpMetadata: (headers: Headers) =>
							object.writeHttpMetadata(headers),
						body: new Blob([sliced]).stream(),
					};
				});
			const owned = vi
				.spyOn(CornerClipAuthority.prototype, 'owned')
				.mockResolvedValue({
					clip: {} as Awaited<ReturnType<CornerClipAuthority['owned']>>['clip'],
					publication: {
						clipId: 'clip-id',
						objectKey: 'private-key',
						checksum: 'a'.repeat(64),
						byteCount: 8,
						renderInputDigest: 'b'.repeat(64),
						durationMs: 100,
						createdAt: '2026-01-01',
					},
				});
			const headers = new Headers();
			if (range) headers.set('Range', range);
			if (ifRange === 'not-modified') headers.set('If-None-Match', '*');
			else if (ifRange === 'precondition-failed')
				headers.set('If-Match', '"missing"');
			else if (ifRange) headers.set('If-Range', ifRange);
			const response = await request(`${root}/clips/clip-id/content`, {
				method,
				headers,
			});
			expect(response.status).toBe(status);
			expect(await response.text()).toBe(body);
			expect(response.headers.get('cache-control')).toBe('private, no-store');
			expect(response.headers.get('etag')).toBe(stored?.httpEtag);
			expect(response.headers.get('x-content-type-options')).toBe('nosniff');
			expect(response.headers.get('accept-ranges')).toBe('bytes');
			expect(owned).toHaveBeenCalledWith(
				'owner-1',
				root.split('/').at(-1),
				'clip-id',
			);
			expect(owned).toHaveBeenCalledTimes(
				method === 'GET' && (status === 200 || status === 206) ? 2 : 1,
			);
			if (method === 'GET' && status === 206) {
				expect(getObject).toHaveBeenCalledWith('private-key', {
					range: { offset: 2, length: 3 },
					onlyIf: { etagMatches: stored?.etag },
				});
				expect(response.headers.get('content-range')).toBe('bytes 2-4/8');
			}
			d1.expectConsumed();
		},
	);

	test('rejects obsolete architecture aliases', async () => {
		const { paths } = await publishedPaths();
		const { request, d1 } = createHonoFixture();
		for (const suffix of ['reidentifications', 'artifacts/artifact-id']) {
			expect((await request(`${root}/${suffix}`)).status).toBe(404);
			expect(
				paths[`/api/v1/driving-analyses/{analysisId}/${suffix}`],
			).toBeUndefined();
		}
		d1.expectConsumed();
	});
});
