import { Container } from '@cloudflare/containers';
import { z } from 'zod';
import {
	MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES,
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationResponse,
	raceVideoValidationRequest,
	raceVideoValidationResponseSchema,
} from './race-video-validation-contracts';

const uuidV4Schema = z
	.string()
	.regex(
		/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
	);

const objectKeySchema = z
	.string()
	.regex(/^race-recordings\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/);

export const raceVideoMediaValidationCommandSchema = z.strictObject({
	recordingId: uuidV4Schema,
	validationId: uuidV4Schema,
	objectKey: objectKeySchema,
	expectedByteCount: z.number().int().positive().safe(),
});

export type RaceVideoMediaValidationCommand = z.infer<
	typeof raceVideoMediaValidationCommandSchema
>;

type RaceVideoMediaContainerRuntime = Readonly<{
	bucket: R2Bucket;
	start(): Promise<void>;
	stage(path: string, body: ReadableStream): Promise<number>;
	probe(request: Request): Promise<Response>;
}>;

const safeRejection = (
	validationId: string,
	code: 'STAGED_MEDIA_NOT_FOUND' | 'STAGED_MEDIA_MISMATCH' | 'INTERNAL_ERROR',
	stage: 'claim' | 'request',
	message: string,
): RaceVideoValidationResponse => ({
	contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	correlationId: validationId,
	outcome: 'rejected',
	error: { code, stage, message },
});

const internalRejection = (validationId: string): RaceVideoValidationResponse =>
	safeRejection(
		validationId,
		'INTERNAL_ERROR',
		'request',
		'The media validation service could not complete validation.',
	);

const readBoundedJson = async (response: Response): Promise<unknown> => {
	const contentType = response.headers
		.get('content-type')
		?.split(';', 1)[0]
		?.trim()
		.toLowerCase();
	if (response.status !== 200 || contentType !== 'application/json')
		throw new Error('Unexpected media validation response');
	const declaredLength = response.headers.get('content-length');
	if (
		declaredLength !== null &&
		(!/^\d+$/.test(declaredLength) ||
			Number(declaredLength) > MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES)
	)
		throw new Error('Oversized media validation response');
	if (!response.body) throw new Error('Empty media validation response');
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteCount = 0;
	for (;;) {
		const { done, value } = await reader.read();
		if (done) break;
		byteCount += value.byteLength;
		if (byteCount > MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES) {
			await reader.cancel();
			throw new Error('Oversized media validation response');
		}
		chunks.push(value);
	}
	const bytes = new Uint8Array(byteCount);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return JSON.parse(
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
	);
};

export const validateRaceVideoMedia = async (
	commandValue: unknown,
	runtime: RaceVideoMediaContainerRuntime,
): Promise<RaceVideoValidationResponse> => {
	const command = raceVideoMediaValidationCommandSchema.parse(commandValue);
	try {
		await runtime.start();
		const source = await runtime.bucket.get(command.objectKey);
		if (!source)
			return safeRejection(
				command.validationId,
				'STAGED_MEDIA_NOT_FOUND',
				'claim',
				'The private Race recording is unavailable.',
			);
		if (
			source.size !== command.expectedByteCount ||
			source.customMetadata?.['recordingId'] !== command.recordingId
		)
			return safeRejection(
				command.validationId,
				'STAGED_MEDIA_MISMATCH',
				'claim',
				'The private Race recording does not match validation state.',
			);
		const stagedPath = `/var/lib/rc-mech/staged/${command.validationId}.media`;
		if ((await runtime.stage(stagedPath, source.body)) !== 0)
			return internalRejection(command.validationId);
		const request = raceVideoValidationRequest(command);
		const rawResponse = await readBoundedJson(
			await runtime.probe(
				new Request('http://driving-analysis-media/v1/media/probe', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(request),
				}),
			),
		);
		const parsed = raceVideoValidationResponseSchema.parse(rawResponse);
		if (
			parsed.correlationId !== command.validationId ||
			(parsed.outcome === 'accepted' &&
				parsed.media.byteCount !== command.expectedByteCount)
		)
			return internalRejection(command.validationId);
		return parsed;
	} catch {
		return internalRejection(command.validationId);
	}
};

type RaceVideoMediaContainerEnvironment = Pick<Env, 'ANALYSIS_MEDIA'>;

export class RaceVideoMediaContainer extends Container<RaceVideoMediaContainerEnvironment> {
	/* c8 ignore next -- declarative Container runtime configuration is verified by Wrangler. */
	defaultPort = 8080;
	/* c8 ignore next -- declarative Container runtime configuration is verified by Wrangler. */
	requiredPorts = [8080];
	/* c8 ignore next -- declarative Container runtime configuration is verified by Wrangler. */
	sleepAfter = '5m';
	/* c8 ignore next -- declarative Container runtime configuration is verified by Wrangler. */
	enableInternet = false;
	/* c8 ignore next -- declarative Container runtime configuration is verified by Wrangler. */
	pingEndpoint = 'driving-analysis-media/health';

	async validateRaceVideo(
		command: unknown,
	): Promise<RaceVideoValidationResponse> {
		return validateRaceVideoMedia(command, {
			bucket: this.env.ANALYSIS_MEDIA,
			start: () =>
				this.startAndWaitForPorts({
					ports: 8080,
					cancellationOptions: {
						instanceGetTimeoutMS: 30_000,
						portReadyTimeoutMS: 30_000,
						waitInterval: 250,
					},
				}),
			stage: async (path, body) => {
				const container = this.ctx.container;
				if (!container) throw new Error('Container execution is unavailable');
				const process = await container.exec(['/usr/bin/tee', path], {
					stdin: body,
					stdout: 'ignore',
					stderr: 'ignore',
					user: '10001:10001',
				});
				return process.exitCode;
			},
			probe: (request) => this.containerFetch(request, 8080),
		});
	}
}
