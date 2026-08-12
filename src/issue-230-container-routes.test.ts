import { expect, test, vi } from 'vitest';
import {
	ISSUE_230_CONTRACT_VERSION,
	runIssue230ContainerRoundTrip,
} from './issue-230-container';
import { createHonoFixture } from './testing/hono-fixture';

const path = '/api/v1/prototypes/python-round-trip';

const post = (
	request: ReturnType<typeof createHonoFixture>['request'],
	body: unknown,
) =>
	request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body),
	});

const resultWith = (response: Response) => async () => ({
	stateBefore: 'healthy' as const,
	startupMs: 1,
	roundTripMs: 2,
	response,
});

const expectError = async (
	response: Response,
	status: number,
	code: string,
) => {
	expect(response.status).toBe(status);
	const body = await response.json<{
		error: { code: string; correlationId: string };
	}>();
	expect(body).toEqual({
		error: { code, correlationId: expect.any(String) },
	});
	expect(body.error.correlationId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
};

test('authenticated caller receives the validated Python container result', async () => {
	const containerRoundTrip = vi.fn(
		async (_env: Env, command: { correlationId: string; value: string }) => ({
			stateBefore: 'stopped' as const,
			startupMs: 1250,
			roundTripMs: 1275,
			response: Response.json({
				contractVersion: 'issue-230.round-trip.v1',
				correlationId: command.correlationId,
				transformedValue: 'python:TRACKSIDE',
			}),
		}),
	);
	const { request } = createHonoFixture({ containerRoundTrip });

	const response = await request(path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ value: 'trackside' }),
	});

	expect(response.status).toBe(200);
	const body = await response.json<{
		result: {
			contractVersion: string;
			correlationId: string;
			transformedValue: string;
			container: {
				instance: string;
				stateBefore: string;
				startupMs: number;
				roundTripMs: number;
			};
		};
	}>();
	expect(body).toEqual({
		result: {
			contractVersion: 'issue-230.round-trip.v1',
			correlationId: expect.any(String),
			transformedValue: 'python:TRACKSIDE',
			container: {
				instance: 'issue-230-round-trip',
				stateBefore: 'stopped',
				startupMs: 1250,
				roundTripMs: 1275,
			},
		},
	});
	expect(body.result.correlationId).toMatch(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
	);
	expect(containerRoundTrip).toHaveBeenCalledWith(expect.any(Object), {
		correlationId: body.result.correlationId,
		value: 'trackside',
	});
});

test('prototype route requires the existing authenticated Hono session', async () => {
	const containerRoundTrip = vi.fn(resultWith(Response.json({})));
	const { request } = createHonoFixture({
		authenticated: false,
		containerRoundTrip,
	});

	const response = await post(request, { value: 'trackside' });

	expect(response.status).toBe(401);
	expect(await response.json()).toEqual({ error: 'Authentication required' });
	expect(containerRoundTrip).not.toHaveBeenCalled();
});

test.each([
	{},
	{ value: '' },
	{ value: 230 },
	{ value: 'pit 🏁' },
	{ value: 'x'.repeat(65) },
	{ value: 'trackside', extra: true },
])(
	'prototype route rejects input outside the bounded contract',
	async (body) => {
		const containerRoundTrip = vi.fn(resultWith(Response.json({})));
		const { request } = createHonoFixture({ containerRoundTrip });

		await expectError(await post(request, body), 400, 'INVALID_REQUEST');
		expect(containerRoundTrip).not.toHaveBeenCalled();
	},
);

test('prototype route rejects malformed and oversized JSON before the Container call', async () => {
	const containerRoundTrip = vi.fn(resultWith(Response.json({})));
	const { request } = createHonoFixture({ containerRoundTrip });

	await expectError(
		await request(path, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: '{',
		}),
		400,
		'INVALID_REQUEST',
	);
	await expectError(
		await post(request, { value: 'x'.repeat(2048) }),
		413,
		'INVALID_REQUEST',
	);
	expect(containerRoundTrip).not.toHaveBeenCalled();
});

test('prototype route returns a safe error when the Container is unavailable', async () => {
	const { request } = createHonoFixture({
		containerRoundTrip: async () => {
			throw new Error('private platform detail');
		},
	});

	const response = await post(request, { value: 'trackside' });

	await expectError(response, 503, 'CONTAINER_UNAVAILABLE');
});

test('prototype route rejects a non-successful Python response', async () => {
	const { request } = createHonoFixture({
		containerRoundTrip: resultWith(
			Response.json({ detail: 'private Python detail' }, { status: 500 }),
		),
	});

	const response = await post(request, { value: 'trackside' });

	await expectError(response, 502, 'CONTAINER_UPSTREAM_ERROR');
});

test.each([
	new Response('not JSON'),
	new Response(null, { headers: { 'content-type': 'application/json' } }),
	new Response('{', { headers: { 'content-type': 'application/json' } }),
	Response.json({
		contractVersion: ISSUE_230_CONTRACT_VERSION,
		correlationId: 'c3d1ea64-7c62-4a1e-a41f-43fe101b7f41',
		transformedValue: 'python:TRACKSIDE',
		extra: true,
	}),
	Response.json({ value: 'x'.repeat(5000) }),
])(
	'prototype route rejects a malformed Python response',
	async (pythonResponse) => {
		const { request } = createHonoFixture({
			containerRoundTrip: resultWith(pythonResponse),
		});

		await expectError(
			await post(request, { value: 'trackside' }),
			502,
			'INVALID_CONTAINER_RESPONSE',
		);
	},
);

test('prototype route rejects a valid response for another correlation ID', async () => {
	const { request } = createHonoFixture({
		containerRoundTrip: resultWith(
			Response.json({
				contractVersion: ISSUE_230_CONTRACT_VERSION,
				correlationId: 'c3d1ea64-7c62-4a1e-a41f-43fe101b7f41',
				transformedValue: 'python:TRACKSIDE',
			}),
		),
	});

	await expectError(
		await post(request, { value: 'trackside' }),
		502,
		'INVALID_CONTAINER_RESPONSE',
	);
});

test('Container gateway selects the fixed instance and sends the versioned request', async () => {
	let forwardedRequest: Request | undefined;
	const getByName = vi.fn(() => ({
		getState: async () => ({ status: 'stopped' as const, lastChange: 0 }),
		startAndWaitForPorts: async () => undefined,
		fetch: async (request: Request) => {
			forwardedRequest = request;
			return Response.json({ ok: true });
		},
	}));
	const env = {
		ISSUE_230_PYTHON_CONTAINER: { getByName },
	} as unknown as Env;
	const time = vi
		.spyOn(performance, 'now')
		.mockReturnValueOnce(100)
		.mockReturnValueOnce(100)
		.mockReturnValueOnce(350)
		.mockReturnValueOnce(500);
	const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

	const result = await runIssue230ContainerRoundTrip(env, {
		correlationId: 'c3d1ea64-7c62-4a1e-a41f-43fe101b7f41',
		value: 'trackside',
	});

	expect(getByName).toHaveBeenCalledWith('issue-230-round-trip');
	expect(forwardedRequest?.url).toBe('http://issue-230-python/v1/round-trip');
	expect(forwardedRequest?.method).toBe('POST');
	expect(await forwardedRequest?.json()).toEqual({
		contractVersion: ISSUE_230_CONTRACT_VERSION,
		correlationId: 'c3d1ea64-7c62-4a1e-a41f-43fe101b7f41',
		value: 'trackside',
	});
	expect(result).toEqual({
		stateBefore: 'stopped',
		startupMs: 250,
		roundTripMs: 400,
		response: expect.any(Response),
	});
	time.mockRestore();
	log.mockRestore();
});
