import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { z } from 'zod';
import type { AppDependencies } from '../app-dependencies';
import {
	ISSUE_230_CONTRACT_VERSION,
	ISSUE_230_INSTANCE_NAME,
} from '../issue-230-container';
import type { AppEnv } from '../types';

const MAX_REQUEST_BYTES = 1024;
const MAX_RESPONSE_BYTES = 4096;

const publicRequest = z
	.object({
		value: z
			.string()
			.min(1)
			.max(64)
			.regex(/^[A-Za-z0-9 -]+$/),
	})
	.strict();

const pythonResponse = z
	.object({
		contractVersion: z.literal(ISSUE_230_CONTRACT_VERSION),
		correlationId: z.string().uuid(),
		transformedValue: z.string().min(1).max(96),
	})
	.strict();

type PrototypeErrorCode =
	| 'INVALID_REQUEST'
	| 'CONTAINER_UNAVAILABLE'
	| 'CONTAINER_UPSTREAM_ERROR'
	| 'INVALID_CONTAINER_RESPONSE';

const errorResponse = (
	correlationId: string,
	code: PrototypeErrorCode,
): { error: { code: PrototypeErrorCode; correlationId: string } } => ({
	error: { code, correlationId },
});

const readBoundedText = async (
	body: ReadableStream<Uint8Array> | null,
	maxBytes: number,
): Promise<string | null> => {
	if (!body) return '';
	const reader = body.getReader();
	const decoder = new TextDecoder();
	let byteCount = 0;
	let value = '';
	while (true) {
		const next = await reader.read();
		if (next.done) return value + decoder.decode();
		byteCount += next.value.byteLength;
		if (byteCount > maxBytes) {
			await reader.cancel();
			return null;
		}
		value += decoder.decode(next.value, { stream: true });
	}
};

export const createIssue230ContainerRoutes = (
	dependencies: AppDependencies,
) => {
	const app = new Hono<AppEnv>();

	app.use(
		'/prototypes/python-round-trip',
		bodyLimit({
			maxSize: MAX_REQUEST_BYTES,
			onError: (c) => {
				const correlationId = crypto.randomUUID();
				return c.json(errorResponse(correlationId, 'INVALID_REQUEST'), 413);
			},
		}),
	);

	app.post('/prototypes/python-round-trip', async (c) => {
		const correlationId = crypto.randomUUID();
		let body: unknown;
		try {
			body = await c.req.json();
		} catch {
			return c.json(errorResponse(correlationId, 'INVALID_REQUEST'), 400);
		}
		const parsedRequest = publicRequest.safeParse(body);
		if (!parsedRequest.success)
			return c.json(errorResponse(correlationId, 'INVALID_REQUEST'), 400);

		console.log(
			JSON.stringify({
				event: 'issue230.worker.request',
				correlationId,
				instance: ISSUE_230_INSTANCE_NAME,
				valueLength: parsedRequest.data.value.length,
			}),
		);

		let result: Awaited<ReturnType<AppDependencies['containerRoundTrip']>>;
		try {
			result = await dependencies.containerRoundTrip(c.env, {
				correlationId,
				value: parsedRequest.data.value,
			});
		} catch {
			return c.json(errorResponse(correlationId, 'CONTAINER_UNAVAILABLE'), 503);
		}

		if (!result.response.ok)
			return c.json(
				errorResponse(correlationId, 'CONTAINER_UPSTREAM_ERROR'),
				502,
			);
		if (
			result.response.headers.get('content-type')?.split(';', 1)[0] !==
			'application/json'
		)
			return c.json(
				errorResponse(correlationId, 'INVALID_CONTAINER_RESPONSE'),
				502,
			);

		const responseText = await readBoundedText(
			result.response.body,
			MAX_RESPONSE_BYTES,
		);
		if (responseText === null)
			return c.json(
				errorResponse(correlationId, 'INVALID_CONTAINER_RESPONSE'),
				502,
			);
		let responseBody: unknown;
		try {
			responseBody = JSON.parse(responseText);
		} catch {
			return c.json(
				errorResponse(correlationId, 'INVALID_CONTAINER_RESPONSE'),
				502,
			);
		}
		const parsedResponse = pythonResponse.safeParse(responseBody);
		if (
			!parsedResponse.success ||
			parsedResponse.data.correlationId !== correlationId
		)
			return c.json(
				errorResponse(correlationId, 'INVALID_CONTAINER_RESPONSE'),
				502,
			);

		console.log(
			JSON.stringify({
				event: 'issue230.worker.response',
				correlationId,
				instance: ISSUE_230_INSTANCE_NAME,
				upstreamStatus: result.response.status,
				startupMs: result.startupMs,
				roundTripMs: result.roundTripMs,
			}),
		);
		return c.json({
			result: {
				...parsedResponse.data,
				container: {
					instance: ISSUE_230_INSTANCE_NAME,
					stateBefore: result.stateBefore,
					startupMs: result.startupMs,
					roundTripMs: result.roundTripMs,
				},
			},
		});
	});

	return app;
};
