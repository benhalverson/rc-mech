import { describe, expect, test, vi } from 'vitest';
import {
	cancelFixture,
	executionIdentityFixture,
	jobStatusFixture,
	PROFILE_DIGEST,
	SEGMENT_ID,
	submissionFixture,
	transferGrantFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	LocalSam31Provider,
	type LocalSam31ProviderConfig,
	resolveProviderUrl,
} from './local-sam31-provider';

type Responder = (request: Request) => Response | Promise<Response>;

const jsonResponse = (
	value: unknown,
	status = 200,
	headers?: HeadersInit,
): Response =>
	new Response(JSON.stringify(value), {
		status,
		headers: { 'content-type': 'application/json', ...headers },
	});

const providerFixture = (
	responder: Responder,
	overrides: Partial<LocalSam31ProviderConfig> = {},
) => {
	const requests: Request[] = [];
	const fetcher = vi.fn(async (input: RequestInfo | URL) => {
		const request = input instanceof Request ? input : new Request(input);
		requests.push(request.clone());
		return responder(request);
	});
	const provider = new LocalSam31Provider({
		origin: 'https://gpu.chassisnotes.com:443',
		accessClientId: 'access-client-id',
		accessClientSecret: 'access-client-secret',
		fetcher,
		...overrides,
	});
	return { fetcher, provider, requests };
};

const rejection = (
	code:
		| 'GPU_CAPACITY_BUSY'
		| 'PROFILE_UNAVAILABLE'
		| 'JOB_NOT_FOUND'
		| 'AUTHORITY_MISMATCH'
		| 'TRANSFER_FAILED'
		| 'TRACKING_FAILED'
		| 'JOB_INTERRUPTED'
		| 'INVALID_REQUEST',
): Response => {
	const messages = {
		GPU_CAPACITY_BUSY: 'GPU execution capacity is busy',
		PROFILE_UNAVAILABLE: 'requested inference profile is unavailable',
		JOB_NOT_FOUND: 'Tracking job was not found',
		AUTHORITY_MISMATCH: 'Tracking authority does not match',
		TRANSFER_FAILED: 'artifact transfer failed safely',
		TRACKING_FAILED: 'Tracking execution failed safely',
		JOB_INTERRUPTED: 'Tracking execution was interrupted',
		INVALID_REQUEST: 'request does not match the execution contract',
	} as const;
	return jsonResponse(
		{
			contractVersion: 'tracking-provider.v1',
			outcome: 'rejected',
			error: { code, message: messages[code] },
		},
		409,
	);
};

describe('LocalSam31Provider', () => {
	test('uses only fixed-origin authenticated submit, status, grant, and cancel requests', async () => {
		const { provider, requests } = providerFixture(() =>
			jsonResponse(jobStatusFixture()),
		);

		expect(await provider.submit(submissionFixture())).toEqual({
			ok: true,
			value: jobStatusFixture(),
		});
		expect(await provider.status(executionIdentityFixture())).toEqual({
			ok: true,
			value: jobStatusFixture(),
		});
		expect(await provider.deliverTransferGrant(transferGrantFixture())).toEqual(
			{
				ok: true,
				value: jobStatusFixture(),
			},
		);
		expect(await provider.cancel(cancelFixture())).toEqual({
			ok: true,
			value: jobStatusFixture(),
		});

		expect(requests.map((request) => request.method)).toEqual([
			'POST',
			'GET',
			'POST',
			'POST',
		]);
		expect(requests.map((request) => new URL(request.url).pathname)).toEqual([
			'/v1/jobs',
			`/v1/jobs/${SEGMENT_ID}`,
			`/v1/jobs/${SEGMENT_ID}/transfer-grants`,
			`/v1/jobs/${SEGMENT_ID}/cancel`,
		]);
		const statusUrl = new URL(requests[1]?.url ?? '');
		expect(Object.fromEntries(statusUrl.searchParams)).toEqual({
			runId: executionIdentityFixture().runId,
			attemptId: executionIdentityFixture().attemptId,
			leaseId: executionIdentityFixture().leaseId,
			fencingToken: '7',
			specificationDigest: executionIdentityFixture().specificationDigest,
			profileDigest: PROFILE_DIGEST,
		});
		for (const request of requests) {
			expect(new URL(request.url).origin).toBe('https://gpu.chassisnotes.com');
			expect(request.redirect).toBe('manual');
			expect(request.headers.get('CF-Access-Client-Id')).toBe(
				'access-client-id',
			);
			expect(request.headers.get('CF-Access-Client-Secret')).toBe(
				'access-client-secret',
			);
		}
		expect(requests[1]?.headers.get('content-type')).toBeNull();
		expect(await requests[0]?.json()).toEqual(submissionFixture());
		expect(await requests[2]?.json()).toEqual(transferGrantFixture());
		expect(await requests[3]?.json()).toEqual(cancelFixture());
	});

	test.each([
		'not a URL',
		'http://gpu.chassisnotes.com',
		'https://gpu.chassisnotes.com:444',
		'https://user@gpu.chassisnotes.com',
		'https://user:secret@gpu.chassisnotes.com',
		'https://gpu.chassisnotes.com/path',
		'https://gpu.chassisnotes.com/?query=value',
		'https://gpu.chassisnotes.com/#fragment',
	])('rejects a nonfixed provider origin: %s', (origin) => {
		expect(
			() =>
				new LocalSam31Provider({
					origin,
					accessClientId: 'id',
					accessClientSecret: 'secret',
				}),
		).toThrow(/GPU provider origin/);
	});

	test('rejects invalid credentials and request bounds at startup', () => {
		const base = {
			origin: 'https://gpu.chassisnotes.com',
			accessClientId: 'id',
			accessClientSecret: 'secret',
		};
		expect(new LocalSam31Provider(base)).toBeInstanceOf(LocalSam31Provider);
		expect(
			() => new LocalSam31Provider({ ...base, accessClientId: '' }),
		).toThrow('GPU provider Access credential is invalid');
		expect(
			() =>
				new LocalSam31Provider({
					...base,
					accessClientSecret: 'x'.repeat(4097),
				}),
		).toThrow('GPU provider Access credential is invalid');
		expect(() => new LocalSam31Provider({ ...base, timeoutMs: 0 })).toThrow(
			'Provider timeout must be a positive integer',
		);
		expect(() => new LocalSam31Provider({ ...base, timeoutMs: 1.5 })).toThrow(
			'Provider timeout must be a positive integer',
		);
		expect(
			() => new LocalSam31Provider({ ...base, maxResponseBytes: -1 }),
		).toThrow('Provider response limit must be a positive integer');
	});

	test.each(['relative', '//other.example/jobs', '/v1\\jobs'])(
		'rejects provider paths that could escape fixed-origin routing: %s',
		(path) => {
			expect(() =>
				resolveProviderUrl(new URL('https://gpu.chassisnotes.com'), path),
			).toThrow('GPU provider path must be relative to its fixed origin');
		},
	);

	test('fails invalid control inputs before making a request', async () => {
		const { fetcher, provider } = providerFixture(() =>
			jsonResponse(jobStatusFixture()),
		);

		expect(
			await provider.submit({ ...submissionFixture(), segmentId: 'invalid' }),
		).toMatchObject({ ok: false, retryable: false });
		expect(
			await provider.status({
				...executionIdentityFixture(),
				leaseId: 'invalid',
			}),
		).toMatchObject({ ok: false, retryable: false });
		expect(
			await provider.cancel({ ...cancelFixture(), fencingToken: 0 }),
		).toMatchObject({ ok: false, retryable: false });
		expect(
			await provider.deliverTransferGrant({
				...transferGrantFixture(),
				url: 'http://r2.example/object',
			}),
		).toMatchObject({ ok: false, retryable: false });
		expect(fetcher).not.toHaveBeenCalled();
	});

	test('maps network failure and timeout to retryable unavailability', async () => {
		const failed = providerFixture(async () => {
			throw new Error('secret network detail');
		}).provider;
		expect(await failed.status(executionIdentityFixture())).toEqual({
			ok: false,
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		});

		const timedOut = providerFixture(
			(request) =>
				new Promise((_resolve, reject) => {
					request.signal.addEventListener('abort', () =>
						reject(new DOMException('timed out', 'AbortError')),
					);
				}),
			{ timeoutMs: 1 },
		).provider;
		expect(await timedOut.status(executionIdentityFixture())).toMatchObject({
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		});

		const slowBody = providerFixture(
			(request) =>
				new Response(
					new ReadableStream({
						start(controller) {
							request.signal.addEventListener('abort', () =>
								controller.error(new DOMException('timed out', 'AbortError')),
							);
						},
					}),
				),
			{ timeoutMs: 1 },
		).provider;
		expect(await slowBody.status(executionIdentityFixture())).toMatchObject({
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		});
	});

	test.each([
		() =>
			new Response(null, {
				status: 302,
				headers: { location: 'https://other.example' },
			}),
		() => new Response(null, { status: 200 }),
		() => new Response('not-json'),
		() => jsonResponse({ ...jobStatusFixture(), unexpected: true }),
		() =>
			jsonResponse(jobStatusFixture(), 200, { 'content-length': 'invalid' }),
		() => jsonResponse(jobStatusFixture(), 200, { 'content-length': '-1' }),
		() => jsonResponse(jobStatusFixture(), 200, { 'content-length': '99999' }),
	])(
		'fails closed on redirect, malformed, or invalid responses',
		async (response) => {
			const { provider } = providerFixture(() => response(), {
				maxResponseBytes: 1024,
			});
			expect(await provider.status(executionIdentityFixture())).toEqual({
				ok: false,
				code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
				retryable: false,
			});
		},
	);

	test('enforces the response limit while streaming without a declared size', async () => {
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode('{"oversized":"'));
				controller.enqueue(encoder.encode('x'.repeat(100)));
				controller.close();
			},
		});
		const { provider } = providerFixture(() => new Response(stream), {
			maxResponseBytes: 16,
		});

		expect(await provider.status(executionIdentityFixture())).toMatchObject({
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
		});
	});

	test('assembles a bounded multi-chunk response before strict parsing', async () => {
		const value = JSON.stringify(jobStatusFixture());
		const midpoint = Math.floor(value.length / 2);
		const encoder = new TextEncoder();
		const stream = new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(encoder.encode(value.slice(0, midpoint)));
				controller.enqueue(encoder.encode(value.slice(midpoint)));
				controller.close();
			},
		});
		const { provider } = providerFixture(
			() =>
				new Response(stream, {
					headers: {
						'content-length': String(encoder.encode(value).byteLength),
					},
				}),
			{ maxResponseBytes: 4096 },
		);

		expect(await provider.status(executionIdentityFixture())).toEqual({
			ok: true,
			value: jobStatusFixture(),
		});
	});

	test.each([
		['GPU_CAPACITY_BUSY', true],
		['PROFILE_UNAVAILABLE', true],
		['TRANSFER_FAILED', true],
		['TRACKING_FAILED', true],
		['JOB_INTERRUPTED', true],
		['JOB_NOT_FOUND', false],
		['AUTHORITY_MISMATCH', false],
		['INVALID_REQUEST', false],
	] as const)(
		'maps safe local rejection %s without provider detail',
		async (code, retryable) => {
			const { provider } = providerFixture(() => rejection(code));
			expect(await provider.status(executionIdentityFixture())).toEqual({
				ok: false,
				code,
				retryable,
			});
		},
	);

	test('fails closed on a malformed provider rejection', async () => {
		const { provider } = providerFixture(() =>
			jsonResponse(
				{
					contractVersion: 'tracking-provider.v1',
					outcome: 'rejected',
					error: {
						code: 'GPU_CAPACITY_BUSY',
						message: 'raw provider detail',
					},
				},
				409,
			),
		);
		expect(await provider.status(executionIdentityFixture())).toMatchObject({
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
		});
	});

	test.each([
		['runId', '88888888-8888-4888-8888-888888888888'],
		['segmentId', '88888888-8888-4888-8888-888888888888'],
		['attemptId', '88888888-8888-4888-8888-888888888888'],
		['leaseId', '88888888-8888-4888-8888-888888888888'],
		['fencingToken', 8],
		['specificationDigest', 'd'.repeat(64)],
		['profileDigest', 'e'.repeat(64)],
	] as const)('fences a status with stale %s', async (field, value) => {
		const status = { ...jobStatusFixture(), [field]: value };
		const { provider } = providerFixture(() => jsonResponse(status));
		expect(await provider.status(executionIdentityFixture())).toMatchObject({
			code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
		});
	});

	test('fences resolved-profile and artifact identity mismatches', async () => {
		const resolvedMismatch = {
			...jobStatusFixture(),
			resolvedProfileDigest: 'e'.repeat(64),
		};
		expect(
			await providerFixture(() =>
				jsonResponse(resolvedMismatch),
			).provider.status(executionIdentityFixture()),
		).toMatchObject({ code: 'TRACKING_PROVIDER_RESPONSE_INVALID' });

		const validArtifact = jobStatusFixture(true);
		const artifactMismatch = {
			...validArtifact,
			artifact: validArtifact.artifact
				? {
						...validArtifact.artifact,
						leaseId: '88888888-8888-4888-8888-888888888888',
					}
				: null,
		};
		expect(
			await providerFixture(() =>
				jsonResponse(artifactMismatch),
			).provider.status(executionIdentityFixture()),
		).toMatchObject({ code: 'TRACKING_PROVIDER_RESPONSE_INVALID' });

		const segmentMismatch = {
			...validArtifact,
			artifact: validArtifact.artifact
				? {
						...validArtifact.artifact,
						segment: {
							...validArtifact.artifact.segment,
							observationSegmentId: '88888888-8888-4888-8888-888888888888',
						},
					}
				: null,
		};
		expect(
			await providerFixture(() =>
				jsonResponse(segmentMismatch),
			).provider.status(executionIdentityFixture()),
		).toMatchObject({ code: 'TRACKING_PROVIDER_RESPONSE_INVALID' });
	});
});
