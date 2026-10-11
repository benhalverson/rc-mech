import { z } from 'zod';
import { LocalSam31Provider } from './local-sam31-provider';
import type {
	TransferGrantBinding,
	TransferGrantSigner,
} from './r2-transfer-grant-authority';

/** Explicit development wiring; production always uses Access and private R2. */
export type LocalAnalysisEnvironment = {
	ENVIRONMENT?: string;
	LOCAL_ANALYSIS_SECRET?: string;
	GPU_PROVIDER_ORIGIN?: string;
	GPU_ACCESS_CLIENT_ID?: string;
	GPU_ACCESS_CLIENT_SECRET?: string;
};

export const localAnalysisEnabled = (env: LocalAnalysisEnvironment): boolean =>
	env.ENVIRONMENT === 'local' && Boolean(env.LOCAL_ANALYSIS_SECRET);

const localKey = (env: LocalAnalysisEnvironment) => {
	const secret = env.LOCAL_ANALYSIS_SECRET ?? '';
	if (!localAnalysisEnabled(env) || !/^[a-f0-9]{64}$/.test(secret))
		throw new Error('Local analysis capability key is unavailable');
	return crypto.subtle.importKey(
		'raw',
		new TextEncoder().encode(secret),
		{ name: 'HMAC', hash: 'SHA-256' },
		false,
		['sign', 'verify'],
	);
};

/** Keep the provider contract HTTPS while using the isolated loopback GPU locally. */
export const createTrackingProvider = (
	env: LocalAnalysisEnvironment,
): LocalSam31Provider =>
	localAnalysisEnabled(env)
		? new LocalSam31Provider({
				origin: 'https://local-gpu.invalid',
				accessClientId: 'local-development',
				accessClientSecret: 'local-development',
				fetcher: (input, init) => {
					const request = new Request(input, init);
					const url = new URL(request.url);
					url.protocol = 'http:';
					url.hostname = '127.0.0.1';
					url.port = '8081';
					return fetch(new Request(url, request));
				},
			})
		: new LocalSam31Provider({
				origin: env.GPU_PROVIDER_ORIGIN ?? '',
				accessClientId: env.GPU_ACCESS_CLIENT_ID ?? '',
				accessClientSecret: env.GPU_ACCESS_CLIENT_SECRET ?? '',
			});

const capabilitySchema = z.strictObject({
	objectKey: z.string().min(1).max(1024),
	contentType: z.string().min(1).max(128),
	method: z.enum(['GET', 'PUT']),
	expiresAt: z.number().int().positive(),
});
const hex = (bytes: ArrayBuffer) =>
	Array.from(new Uint8Array(bytes), (b) =>
		b.toString(16).padStart(2, '0'),
	).join('');
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
export const LOCAL_ANALYSIS_TRANSFER_PATH = '/__local-analysis-transfer';

export class LocalAnalysisTransferSigner implements TransferGrantSigner {
	constructor(private readonly env: LocalAnalysisEnvironment) {}
	async sign(
		binding: TransferGrantBinding,
		expiresInSeconds: number,
		nowEpochSeconds: number,
	): Promise<string> {
		const payload = JSON.stringify(
			capabilitySchema.parse({
				objectKey: binding.objectKey,
				contentType: binding.contentType,
				method: binding.method,
				expiresAt: nowEpochSeconds + expiresInSeconds,
			}),
		);
		const signature = hex(
			await crypto.subtle.sign(
				'HMAC',
				await localKey(this.env),
				new TextEncoder().encode(payload),
			),
		);
		const url = new URL(
			`https://127.0.0.1:9443${LOCAL_ANALYSIS_TRANSFER_PATH}`,
		);
		url.searchParams.set('capability', payload);
		url.searchParams.set('signature', signature);
		return url.href;
	}
}

/** TLS development proxy forwards only signed, method-bound, expiring capabilities. */
export const localAnalysisTransfer = async (
	request: Request,
	env: LocalAnalysisEnvironment & { ANALYSIS_MEDIA: R2Bucket },
	now = Math.floor(Date.now() / 1000),
): Promise<Response> => {
	const deny = () => new Response(null, { status: 404 });
	const url = new URL(request.url);
	if (
		!localAnalysisEnabled(env) ||
		!['127.0.0.1', 'localhost'].includes(url.hostname) ||
		url.pathname !== LOCAL_ANALYSIS_TRANSFER_PATH
	)
		return deny();
	const payload = url.searchParams.get('capability');
	const signature = url.searchParams.get('signature') ?? '';
	if (!payload || payload.length > 4096 || !/^[a-f0-9]{64}$/.test(signature))
		return deny();
	let capability: z.infer<typeof capabilitySchema>;
	try {
		if (
			!(await crypto.subtle.verify(
				'HMAC',
				await localKey(env),
				Uint8Array.from({ length: 32 }, (_, index) =>
					Number.parseInt(signature.slice(index * 2, index * 2 + 2), 16),
				),
				new TextEncoder().encode(payload),
			))
		)
			return deny();
		capability = capabilitySchema.parse(JSON.parse(payload));
	} catch {
		return deny();
	}
	if (
		capability.method !== request.method ||
		capability.expiresAt <= now ||
		capability.expiresAt > now + 1800
	)
		return deny();
	if (request.method === 'GET') {
		const object = await env.ANALYSIS_MEDIA.get(capability.objectKey);
		return object
			? new Response(object.body, {
					headers: {
						'Content-Type': capability.contentType,
						'Content-Length': String(object.size),
						'Cache-Control': 'no-store',
					},
				})
			: deny();
	}
	if (request.headers.get('content-type') !== capability.contentType)
		return deny();
	const length = Number(request.headers.get('content-length'));
	if (
		!Number.isSafeInteger(length) ||
		length <= 0 ||
		length > MAX_OUTPUT_BYTES ||
		!request.body
	)
		return deny();
	const reader = request.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { value, done } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > length) {
				await reader.cancel();
				return deny();
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	if (size !== length) return deny();
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	await env.ANALYSIS_MEDIA.put(capability.objectKey, bytes, {
		httpMetadata: { contentType: capability.contentType },
	});
	return new Response(null, { status: 200 });
};
