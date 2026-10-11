import { afterEach, expect, test, vi } from 'vitest';
import {
	executionIdentityFixture,
	jobStatusFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	createTrackingProvider,
	LocalAnalysisTransferSigner,
	localAnalysisEnabled,
	localAnalysisTransfer,
} from './local-development';

const secret = 'a'.repeat(64);
const fixture = () => {
	const get = vi.fn(async () => ({
		body: new Response('video').body,
		size: 5,
	}));
	const put = vi.fn(async () => null);
	const env = {
		ENVIRONMENT: 'local',
		LOCAL_ANALYSIS_SECRET: secret,
		ANALYSIS_MEDIA: { get, put } as unknown as R2Bucket,
	};
	const signer = new LocalAnalysisTransferSigner(env);
	const sign = (method: 'GET' | 'PUT' = 'GET', expires = 60) =>
		signer.sign(
			{
				objectKey: 'tracking/test',
				contentType: 'application/octet-stream',
				method,
			},
			expires,
			1000,
		);
	return { env, sign, get, put };
};
afterEach(() => vi.unstubAllGlobals());

test('only explicit local configuration selects the loopback provider', async () => {
	expect(
		localAnalysisEnabled({
			ENVIRONMENT: 'production',
			LOCAL_ANALYSIS_SECRET: secret,
		}),
	).toBe(false);
	expect(localAnalysisEnabled({ ENVIRONMENT: 'local' })).toBe(false);
	expect(() => createTrackingProvider({})).toThrow();
	const fetcher = vi.fn(async (_input: Request) =>
		Response.json(jobStatusFixture()),
	);
	vi.stubGlobal('fetch', fetcher);
	const provider = createTrackingProvider({
		ENVIRONMENT: 'local',
		LOCAL_ANALYSIS_SECRET: secret,
	});
	expect((await provider.status(executionIdentityFixture())).ok).toBe(true);
	expect(fetcher.mock.calls[0]?.[0].url).toContain(
		'http://127.0.0.1:8081/v1/jobs/',
	);
});

test('valid scoped capabilities stream local input and publish bounded output', async () => {
	const { env, sign, get, put } = fixture();
	const response = await localAnalysisTransfer(
		new Request(await sign()),
		env,
		1001,
	);
	expect(response.status).toBe(200);
	expect(await response.text()).toBe('video');
	expect(get).toHaveBeenCalledWith('tracking/test');
	const output = await localAnalysisTransfer(
		new Request(await sign('PUT'), {
			method: 'PUT',
			body: 'result',
			headers: {
				'content-type': 'application/octet-stream',
				'content-length': '6',
			},
		}),
		env,
		1001,
	);
	expect(output.status).toBe(200);
	expect(put).toHaveBeenCalledWith(
		'tracking/test',
		new TextEncoder().encode('result'),
		{ httpMetadata: { contentType: 'application/octet-stream' } },
	);
});

test('production, public hosts, wrong paths, modified, expired and wrong-method grants fail closed', async () => {
	const { env, sign, get } = fixture();
	const valid = await sign();
	const tampered = new URL(valid);
	tampered.searchParams.set('capability', '{}');
	const requests = [
		new Request(valid.replace('127.0.0.1', 'example.com')),
		new Request(valid.replace('__local-analysis-transfer', 'other')),
		new Request(tampered),
		new Request(valid, { method: 'POST' }),
		new Request('https://localhost/__local-analysis-transfer'),
		new Request(valid.replace(/signature=[^&]+/, 'signature=x')),
	];
	for (const request of requests)
		expect((await localAnalysisTransfer(request, env, 1001)).status).toBe(404);
	expect(
		(
			await localAnalysisTransfer(
				new Request(valid),
				{ ...env, ENVIRONMENT: 'production' },
				1001,
			)
		).status,
	).toBe(404);
	expect(
		(await localAnalysisTransfer(new Request(valid), env, 1060)).status,
	).toBe(404);
	expect(
		(
			await localAnalysisTransfer(
				new Request(await sign('GET', 2000)),
				env,
				1001,
			)
		).status,
	).toBe(404);
	expect(get).not.toHaveBeenCalled();
});

test('invalid secrets and missing objects fail closed', async () => {
	const { env, sign, get } = fixture();
	await expect(
		new LocalAnalysisTransferSigner({}).sign(
			{ objectKey: 'x', contentType: 'x', method: 'GET' },
			60,
			1000,
		),
	).rejects.toThrow();
	await expect(
		new LocalAnalysisTransferSigner({
			...env,
			LOCAL_ANALYSIS_SECRET: 'short',
		}).sign({ objectKey: 'x', contentType: 'x', method: 'GET' }, 60, 1000),
	).rejects.toThrow();
	expect(
		(
			await localAnalysisTransfer(
				new Request(await sign()),
				{ ...env, LOCAL_ANALYSIS_SECRET: 'short' },
				1001,
			)
		).status,
	).toBe(404);
	get.mockResolvedValueOnce(null as never);
	expect(
		(await localAnalysisTransfer(new Request(await sign()), env, 1001)).status,
	).toBe(404);
});

test('output grants reject type, length and streaming-size mismatches without writes', async () => {
	const { env, sign, put } = fixture();
	for (const headers of [
		{ 'content-type': 'text/plain', 'content-length': '3' },
		{ 'content-type': 'application/octet-stream' },
		{
			'content-type': 'application/octet-stream',
			'content-length': String(64 * 1024 * 1024 + 1),
		},
		{ 'content-type': 'application/octet-stream', 'content-length': '2' },
		{ 'content-type': 'application/octet-stream', 'content-length': '4' },
	]) {
		const response = await localAnalysisTransfer(
			new Request(await sign('PUT'), { method: 'PUT', body: 'abc', headers }),
			env,
			1001,
		);
		expect(response.status).toBe(404);
	}
	expect(put).not.toHaveBeenCalled();
});
