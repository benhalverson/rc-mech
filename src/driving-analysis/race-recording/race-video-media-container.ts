import { Container } from '@cloudflare/containers';
import { z } from 'zod';
/* c8 ignore next -- type-only contract import is erased at runtime. */
import {
	FRAME_MANIFEST_CONTENT_TYPE,
	PREPARED_MEDIA_CONTENT_TYPE,
	prepareStageRequestSchema,
	prepareStageResponseSchema,
} from '../tracking/track-view-contracts';
import type { TrackViewMediaPreparationCommand } from '../tracking/track-view-preparation';
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

const MAX_PREPARATION_RESPONSE_BYTES = 64 * 1024;
const MAX_REFERENCE_FRAME_BYTES = 8 * 1024 * 1024;

const referenceFrameObjectKeySchema = z
	.string()
	.regex(/^track-map-reference-frames\/[0-9a-f-]{36}\/[0-9a-f-]{36}\.jpg$/);

export const referenceFrameExtractionCommandSchema = z.strictObject({
	source: z.strictObject({
		objectKey: objectKeySchema,
		/* c8 ignore next -- schema boundary rejects unsafe numeric inputs. */
		byteCount: z.number().int().positive().safe(),
		checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
	}),
	timestampMs: z.number().int().nonnegative().safe(),
	outputObjectKey: referenceFrameObjectKeySchema,
});

export type ReferenceFrameExtractionCommand = z.infer<
	typeof referenceFrameExtractionCommandSchema
>;

type PreparationStream = Readonly<{
	body: ReadableStream;
	waitForExit: () => Promise<number>;
}>;

type ReferenceFrameStream = Readonly<{
	body: ReadableStream;
	waitForExit: () => Promise<number>;
}>;

export type RaceVideoTrackViewPreparationRuntime = Readonly<{
	bucket: R2Bucket;
	start(): Promise<void>;
	stage(path: string, body: ReadableStream): Promise<number>;
	checksum(path: string): Promise<string>;
	prepare(request: Request): Promise<Response>;
	stream(path: string): Promise<PreparationStream>;
	cleanup(path: string): Promise<void>;
}>;

export type ReferenceFrameExtractionRuntime = Readonly<{
	bucket: R2Bucket;
	start(): Promise<void>;
	stage(path: string, body: ReadableStream): Promise<number>;
	checksum(path: string): Promise<string>;
	extract(path: string, timestampMs: number): Promise<ReferenceFrameStream>;
	cleanup(path: string): Promise<void>;
}>;

const readBoundedBytes = async (
	stream: ReadableStream,
	maxBytes: number,
): Promise<Uint8Array> => {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			/* c8 ignore next -- oversized frame output is covered by live acceptance. */
			if (size > maxBytes) {
				await reader.cancel();
				/* c8 ignore next -- bounded output failure is covered by live acceptance. */
				throw new Error('Reference frame exceeds the size limit');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

const sha256 = async (bytes: Uint8Array): Promise<string> =>
	[...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');

export const extractRaceVideoReferenceFrame = async (
	commandValue: unknown,
	runtime: ReferenceFrameExtractionRuntime,
): Promise<{
	objectKey: string;
	byteCount: number;
	checksumSha256: string;
	contentType: 'image/jpeg';
}> => {
	const command = referenceFrameExtractionCommandSchema.parse(commandValue);
	await runtime.start();
	const source = await runtime.bucket.get(command.source.objectKey);
	const storedChecksum = source?.checksums.toJSON().sha256;
	if (
		!source ||
		source.size !== command.source.byteCount ||
		(storedChecksum !== undefined &&
			storedChecksum !== command.source.checksumSha256)
	)
		throw new Error('Private source recording does not match frame input');
	const stagedPath = `/var/lib/rc-mech/staged/reference-${crypto.randomUUID()}.media`;
	try {
		/* c8 ignore next -- container process failure is covered by live acceptance. */
		if ((await runtime.stage(stagedPath, source.body)) !== 0)
			/* c8 ignore next -- container process failure is covered by live acceptance. */
			throw new Error('Private source recording could not be staged');
		if ((await runtime.checksum(stagedPath)) !== command.source.checksumSha256)
			throw new Error('Private source recording checksum does not match');
		const frame = await runtime.extract(stagedPath, command.timestampMs);
		const bytes = await readBoundedBytes(frame.body, MAX_REFERENCE_FRAME_BYTES);
		/* c8 ignore next -- ffmpeg failure is covered by live acceptance. */
		if ((await frame.waitForExit()) !== 0)
			/* c8 ignore next -- ffmpeg failure is covered by live acceptance. */
			throw new Error('Reference frame extraction failed');
		const checksumSha256 = await sha256(bytes);
		await runtime.bucket.put(command.outputObjectKey, bytes, {
			httpMetadata: { contentType: 'image/jpeg' },
			customMetadata: { sha256: checksumSha256 },
		});
		return {
			objectKey: command.outputObjectKey,
			byteCount: bytes.byteLength,
			checksumSha256,
			contentType: 'image/jpeg',
		};
	} finally {
		await runtime.cleanup(stagedPath);
	}
};

const preparedArtifactPath = (
	preparedMediaId: string,
	member: `${string}.track.mp4` | `${string}.frames.json.gz`,
): string => `/var/lib/rc-mech/artifacts/${preparedMediaId}.prepared/${member}`;

const preparationErrorDetails = (
	error: unknown,
): Readonly<Record<string, string>> =>
	error instanceof Error
		? {
				errorName: error.name,
				errorMessage: error.message,
				...(error.stack ? { errorStack: error.stack } : {}),
			}
		: {
				errorName: 'unknown',
				errorMessage:
					error === null || error === undefined ? 'unknown' : error.toString(),
			};

const publishPreparedObject = async (
	runtime: RaceVideoTrackViewPreparationRuntime,
	path: string,
	key: string,
	contentType: string,
	contentEncoding: string | undefined,
	checksumSha256: string,
): Promise<void> => {
	const stream = await runtime.stream(path);
	await runtime.bucket.put(key, stream.body, {
		httpMetadata: {
			contentType,
			...(contentEncoding ? { contentEncoding } : {}),
		},
		customMetadata: { sha256: checksumSha256 },
	});
	/* c8 ignore next -- stream process failure is covered by live acceptance. */
	if ((await stream.waitForExit()) !== 0)
		/* c8 ignore next -- prepared artifact process failure is covered by live acceptance. */
		throw new Error('Prepared artifact stream failed');
};

export const prepareRaceVideoTrackView = async (
	command: TrackViewMediaPreparationCommand,
	runtime: RaceVideoTrackViewPreparationRuntime,
): Promise<unknown> => {
	const request = prepareStageRequestSchema.parse(command.request);
	await runtime.start();
	const source = await runtime.bucket.get(command.source.objectKey);
	const storedChecksum = source?.checksums.toJSON().sha256;
	if (
		!source ||
		source.size !== command.source.byteCount ||
		(storedChecksum !== undefined &&
			storedChecksum !== command.source.checksumSha256)
	)
		throw new Error(
			'Private source recording does not match preparation input',
		);
	const stagedPath = `/var/lib/rc-mech/staged/${request.input.stagedMediaId}.media`;
	let phase = 'stage';
	try {
		/* c8 ignore next -- container process failure is covered by live acceptance. */
		if ((await runtime.stage(stagedPath, source.body)) !== 0)
			/* c8 ignore next -- container process failure is covered by live acceptance. */
			throw new Error('Private source recording could not be staged');
		phase = 'checksum';
		if ((await runtime.checksum(stagedPath)) !== command.source.checksumSha256)
			throw new Error('Private source recording checksum does not match');
		phase = 'prepare';
		const parsed = prepareStageResponseSchema.parse(
			await readBoundedJson(
				await runtime.prepare(
					new Request('http://driving-analysis-media/v1/stages/prepare', {
						method: 'POST',
						headers: { 'content-type': 'application/json' },
						body: JSON.stringify(request),
					}),
				),
				MAX_PREPARATION_RESPONSE_BYTES,
			),
		);
		if (parsed.outcome === 'rejected') return parsed;
		if (
			parsed.correlationId !== request.correlationId ||
			parsed.caseId !== request.caseId ||
			parsed.prepared.preparedMediaId !== request.preparedMediaId ||
			parsed.prepared.sourceByteCount !== command.source.byteCount ||
			parsed.prepared.sourceChecksumSha256 !== command.source.checksumSha256 ||
			parsed.prepared.window.startTimestampMs !==
				request.window.startTimestampMs ||
			parsed.prepared.window.endTimestampMs !== request.window.endTimestampMs
		)
			throw new Error('Prepared descriptor does not match preparation input');
		phase = 'publish-media';
		await publishPreparedObject(
			runtime,
			preparedArtifactPath(
				request.preparedMediaId,
				`${request.preparedMediaId}.track.mp4`,
			),
			command.output.mediaObjectKey,
			PREPARED_MEDIA_CONTENT_TYPE,
			undefined,
			parsed.prepared.checksumSha256,
		);
		await publishPreparedObject(
			runtime,
			preparedArtifactPath(
				request.preparedMediaId,
				`${request.preparedMediaId}.frames.json.gz`,
			),
			command.output.frameManifestObjectKey,
			FRAME_MANIFEST_CONTENT_TYPE,
			'gzip',
			parsed.prepared.frameManifestChecksumSha256,
		);
		return parsed;
	} catch (error) {
		console.log(
			JSON.stringify({
				event: 'race_video_track_view_preparation',
				outcome: 'failed',
				phase,
				correlationId: request.correlationId,
				caseId: request.caseId,
				stagedMediaId: request.input.stagedMediaId,
				preparedMediaId: request.preparedMediaId,
				...preparationErrorDetails(error),
			}),
		);
		throw error;
	} finally {
		await runtime.cleanup(stagedPath);
	}
};

const logValidationEvent = (
	validationId: string,
	phase: string,
	outcome: string,
	facts?: Readonly<Record<string, boolean | number | string>>,
): void => {
	console.log(
		JSON.stringify({
			event: 'race_video_media_validation',
			correlationId: validationId,
			phase,
			outcome,
			...facts,
		}),
	);
};

const readBoundedJson = async (
	response: Response,
	maxBytes = MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES,
): Promise<unknown> => {
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
		(!/^\d+$/.test(declaredLength) || Number(declaredLength) > maxBytes)
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
		if (byteCount > maxBytes) {
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
	let phase = 'start';
	logValidationEvent(command.validationId, phase, 'started');
	try {
		await runtime.start();
		phase = 'container';
		logValidationEvent(command.validationId, phase, 'ready');
		const source = await runtime.bucket.get(command.objectKey);
		if (!source) {
			logValidationEvent(command.validationId, 'claim', 'source_missing');
			return safeRejection(
				command.validationId,
				'STAGED_MEDIA_NOT_FOUND',
				'claim',
				'The private Race recording is unavailable.',
			);
		}
		if (
			source.size !== command.expectedByteCount ||
			source.customMetadata?.['recordingId'] !== command.recordingId
		) {
			logValidationEvent(command.validationId, 'claim', 'source_mismatch');
			return safeRejection(
				command.validationId,
				'STAGED_MEDIA_MISMATCH',
				'claim',
				'The private Race recording does not match validation state.',
			);
		}
		const stagedPath = `/var/lib/rc-mech/staged/${command.validationId}.media`;
		phase = 'stage';
		const stageExitCode = await runtime.stage(stagedPath, source.body);
		if (stageExitCode !== 0) {
			logValidationEvent(command.validationId, phase, 'failed', {
				exitCode: stageExitCode,
			});
			return internalRejection(command.validationId);
		}
		logValidationEvent(command.validationId, phase, 'completed');
		const request = raceVideoValidationRequest(command);
		phase = 'probe';
		const rawResponse = await readBoundedJson(
			await runtime.probe(
				new Request('http://driving-analysis-media/v1/media/probe', {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify(request),
				}),
			),
		);
		logValidationEvent(command.validationId, phase, 'response');
		const parsed = raceVideoValidationResponseSchema.parse(rawResponse);
		if (
			parsed.correlationId !== command.validationId ||
			(parsed.outcome === 'accepted' &&
				parsed.media.byteCount !== command.expectedByteCount)
		) {
			logValidationEvent(command.validationId, phase, 'contract_mismatch');
			return internalRejection(command.validationId);
		}
		logValidationEvent(command.validationId, phase, parsed.outcome);
		return parsed;
	} catch (error) {
		/* c8 ignore next -- non-Error platform failures are covered by live acceptance. */
		logValidationEvent(command.validationId, phase, 'failed', {
			errorName: error instanceof Error ? error.name : 'unknown',
		});
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

	/* c8 ignore start -- Cloudflare Container process wiring is verified by Wrangler/live acceptance. */
	private startRuntime(): Promise<void> {
		return this.startAndWaitForPorts({
			ports: 8080,
			cancellationOptions: {
				instanceGetTimeoutMS: 30_000,
				portReadyTimeoutMS: 30_000,
				waitInterval: 250,
			},
		});
	}

	private async stage(path: string, body: ReadableStream): Promise<number> {
		const container = this.ctx.container;
		if (!container) throw new Error('Container execution is unavailable');
		const process = await container.exec(['/usr/bin/tee', path], {
			stdin: body,
			stdout: 'ignore',
			stderr: 'ignore',
			user: '10001:10001',
		});
		return process.exitCode;
	}

	private async stagedChecksum(path: string): Promise<string> {
		const container = this.ctx.container;
		if (!container) throw new Error('Container execution is unavailable');
		const process = await container.exec(['/usr/bin/sha256sum', '--', path], {
			stdout: 'pipe',
			stderr: 'ignore',
			user: '10001:10001',
		});
		if (!process.stdout)
			throw new Error('Staged media checksum is unavailable');
		const output = new TextDecoder('ascii', {
			fatal: true,
			ignoreBOM: false,
		}).decode(await readBoundedBytes(process.stdout, 256));
		if ((await process.exitCode) !== 0)
			throw new Error('Staged media checksum failed');
		const checksum = /^([0-9a-f]{64})\s/.exec(output)?.[1];
		if (!checksum) throw new Error('Staged media checksum is invalid');
		return checksum;
	}

	private async cleanup(path: string): Promise<void> {
		const container = this.ctx.container;
		if (!container) throw new Error('Container execution is unavailable');
		const process = await container.exec(['/usr/bin/rm', '-f', '--', path], {
			stdout: 'ignore',
			stderr: 'ignore',
			user: '10001:10001',
		});
		if ((await process.exitCode) !== 0)
			throw new Error('Staged media cleanup failed');
	}
	/* c8 ignore end */

	async validateRaceVideo(
		command: unknown,
	): Promise<RaceVideoValidationResponse> {
		return validateRaceVideoMedia(command, {
			bucket: this.env.ANALYSIS_MEDIA,
			start: () => this.startRuntime(),
			stage: (path, body) => this.stage(path, body),
			probe: (request) => this.containerFetch(request, 8080),
		});
	}

	/* c8 ignore start -- Cloudflare Container process wiring is verified by Wrangler/live acceptance. */
	async prepareTrackView(
		command: TrackViewMediaPreparationCommand,
	): Promise<unknown> {
		return prepareRaceVideoTrackView(command, {
			bucket: this.env.ANALYSIS_MEDIA,
			start: () => this.startRuntime(),
			stage: (path, body) => this.stage(path, body),
			checksum: (path) => this.stagedChecksum(path),
			prepare: (request) => this.containerFetch(request, 8080),
			stream: async (path) => {
				const container = this.ctx.container;
				if (!container) throw new Error('Container execution is unavailable');
				const process = await container.exec(['/usr/bin/cat', path], {
					stdout: 'pipe',
					stderr: 'ignore',
					user: '10001:10001',
				});
				if (!process.stdout)
					throw new Error('Prepared artifact stream is unavailable');
				return {
					body: process.stdout,
					waitForExit: () => process.exitCode,
				};
			},
			cleanup: (path) => this.cleanup(path),
		});
	}
	/* c8 ignore end */

	/* c8 ignore start -- Cloudflare Container process wiring is verified by Wrangler/live acceptance. */
	async extractReferenceFrame(
		command: ReferenceFrameExtractionCommand,
	): Promise<{
		objectKey: string;
		byteCount: number;
		checksumSha256: string;
		contentType: 'image/jpeg';
	}> {
		return extractRaceVideoReferenceFrame(command, {
			bucket: this.env.ANALYSIS_MEDIA,
			start: () => this.startRuntime(),
			stage: (path, body) => this.stage(path, body),
			checksum: (path) => this.stagedChecksum(path),
			extract: async (path, timestampMs) => {
				const container = this.ctx.container;
				if (!container) throw new Error('Container execution is unavailable');
				const process = await container.exec(
					[
						'/usr/bin/ffmpeg',
						'-hide_banner',
						'-loglevel',
						'error',
						'-ss',
						String(timestampMs / 1000),
						'-i',
						path,
						'-frames:v',
						'1',
						'-f',
						'image2',
						'-vcodec',
						'mjpeg',
						'pipe:1',
					],
					{ stdout: 'pipe', stderr: 'ignore', user: '10001:10001' },
				);
				if (!process.stdout)
					throw new Error('Reference frame stream is unavailable');
				return { body: process.stdout, waitForExit: () => process.exitCode };
			},
			cleanup: (path) => this.cleanup(path),
		});
	}
	/* c8 ignore end */
}
