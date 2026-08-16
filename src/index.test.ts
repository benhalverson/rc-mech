import { expect, test } from 'vitest';
import app from './index';

const emptyResult = <T = Record<string, unknown>>(): D1Result<T> => ({
	success: true,
	meta: {} as D1Meta & Record<string, unknown>,
	results: [],
});

const mockD1 = (): D1Database => {
	const statement = {
		bind: (..._values: unknown[]) => statement,
		first: async <T = Record<string, unknown>>(_columnName?: string) =>
			null as T | null,
		all: async <T = Record<string, unknown>>() => emptyResult<T>(),
		run: async <T = Record<string, unknown>>() => emptyResult<T>(),
	};

	return {
		prepare: (_query: string) => statement,
		batch: async <T = unknown>(_statements: D1PreparedStatement[]) =>
			_statements.map(() => emptyResult<T>()),
	} as unknown as D1Database;
};

const mockR2 = {
	head: async () => null,
	get: async () => null,
	put: async () => null,
	delete: async () => undefined,
	list: async () => ({ objects: [], truncated: false }),
} as unknown as R2Bucket;

const mockAi = {
	aiGatewayLogId: null,
	gateway: () => {
		throw new Error('Unexpected Workers AI gateway call in backend tests');
	},
	aiSearch: () => {
		throw new Error('Unexpected AI Search call in backend tests');
	},
	autorag: () => {
		throw new Error('Unexpected AutoRAG call in backend tests');
	},
	run: () => {
		throw new Error('Unexpected Workers AI call in backend tests');
	},
	models: async () => [],
	toMarkdown: () => {
		throw new Error('Unexpected Markdown conversion in backend tests');
	},
} satisfies Ai;

const MOCK_ENV = {
	DB: mockD1(),
	PHOTOS: mockR2,
	ANALYSIS_MEDIA: mockR2,
	EMAIL: {
		send: async () => {
			throw new Error('Unexpected email delivery in backend tests');
		},
	},
	AI: mockAi,
	ASSETS: {
		fetch: async (input: RequestInfo | URL) => {
			const request = new Request(input);
			return new URL(request.url).pathname === '/'
				? new Response('<app-root></app-root>', {
						headers: { 'content-type': 'text/html' },
					})
				: new Response('Not found', { status: 404 });
		},
	} as unknown as Fetcher,
	APP_URL: 'http://localhost:8787',
	ENVIRONMENT: 'local',
	GPU_LEASE_COORDINATOR: {} as Env['GPU_LEASE_COORDINATOR'],
} satisfies Env;

const request = (path: string, init?: RequestInit) =>
	app.request(path, init, MOCK_ENV);

test('health is exposed through the Worker request interface', async () => {
	const response = await request('/api/v1/health');

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ ok: true, service: 'rc-mech' });
});

test('OpenAPI documents invite and workspace aggregate endpoints', async () => {
	const response = await request('/api/openapi.json');
	const document = (await response.json()) as {
		info: { title: string };
		paths: Record<string, unknown>;
	};

	expect(response.status).toBe(200);
	expect(document.info.title).toBe('Chassis Notes API');
	expect(document.paths['/api/auth/register']).toBeDefined();
	expect(document.paths['/api/v1/invite-codes']).toBeDefined();
	expect(document.paths['/api/v1/invite-codes/{id}/revoke']).toBeDefined();
	expect(document.paths['/api/v1/service-records']).toBeDefined();
	expect(document.paths['/api/v1/consumable-maintenance']).toBeDefined();
	expect(document.paths['/api/v1/consumables/report']).toBeDefined();
	expect(document.paths['/api/v1/setups']).toBeDefined();
	const syncOperation = document.paths[
		'/api/v1/sync/operations/{operationId}'
	] as {
		put: {
			requestBody: {
				content: {
					'application/json': {
						schema: {
							properties: {
								command: {
									oneOf: readonly {
										properties: { type: { const: string } };
									}[];
								};
							};
						};
					};
				};
			};
		};
	};
	expect(
		syncOperation.put.requestBody.content[
			'application/json'
		].schema.properties.command.oneOf.map(
			(command) => command.properties.type.const,
		),
	).toEqual([
		'car.create',
		'car.edit',
		'car.archive',
		'car.restore',
		'setup.create',
		'setup.correct',
		'setup.select-current',
	]);
	expect(document.paths['/api/v1/cars/{carId}/voice-updates']).toBeDefined();
	expect(
		document.paths['/api/v1/voice-updates/{voiceUpdateId}/confirm'],
	).toBeDefined();
	expect(
		document.paths[
			'/api/v1/voice-updates/{voiceUpdateId}/corrections/{correctionId}/audio'
		],
	).toBeDefined();
	const correction = document.paths[
		'/api/v1/voice-updates/{voiceUpdateId}/corrections'
	] as {
		post: {
			requestBody: {
				content: {
					'application/json': {
						schema: {
							properties: {
								text: { maxLength: number; description: string };
							};
						};
					};
				};
			};
		};
	};
	const correctionText =
		correction.post.requestBody.content['application/json'].schema.properties
			.text;
	expect(correctionText.maxLength).toBe(4000);
	expect(correctionText.description).toContain('full correction');
	const registration = document.paths['/api/auth/register'] as {
		post: { responses: Record<string, unknown> };
	};
	expect(registration.post.responses['400']).toBeUndefined();
});

test('registration keeps malformed requests on the neutral contract', async () => {
	const response = await request('/api/auth/register', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: 'not-an-email' }),
	});

	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ status: true });
});

test('unknown API routes return the JSON API 404 contract', async () => {
	const response = await request('/api/does-not-exist');

	expect(response.status).toBe(404);
	expect(await response.json()).toEqual({ error: 'Not found' });
});

test.each([
	'/.env',
	'/.git/HEAD',
	'/.aws/credentials',
	'/app/.env',
	'/backend/.env.production',
	'/%2eenv',
	'/%2egit/HEAD',
])('hidden-file probe %s does not use the SPA fallback', async (path) => {
	const response = await request(path, {
		headers: { Accept: 'text/html' },
	});

	expect(response.status).toBe(404);
	expect(await response.text()).toBe('Not found');
});

test.each([
	'/api/v1/cars',
	'/api/v1/service-records',
	'/api/v1/consumable-maintenance',
	'/api/v1/consumables/report',
])(
	'protected route %s requires authentication using the configured D1 binding',
	async (path) => {
		const response = await request(path);

		expect(response.status).toBe(401);
		expect(await response.json()).toEqual({ error: 'Authentication required' });
	},
);

test('authentication rejects invalid request input through the Worker interface', async () => {
	const response = await request('/api/auth/sign-in/magic-link', {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify({ email: 123 }),
	});

	expect(response.status).toBe(400);
});

test('test fixtures expose configured D1 and R2 bindings', () => {
	expect(MOCK_ENV.DB).toBeDefined();
	expect(MOCK_ENV.PHOTOS).toBeDefined();
});
