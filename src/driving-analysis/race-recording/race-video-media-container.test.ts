import { describe, expect, test, vi } from 'vitest';
import acceptedFixture from '../../../containers/driving-analysis/tests/fixtures/race-video-validation/accepted.json';
import rejectedFixture from '../../../containers/driving-analysis/tests/fixtures/race-video-validation/rejected.json';
import { RUN_ID } from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	CORRELATION_ID,
	prepareAcceptedFixture,
	preparedDescriptorFixture,
	RACE_VIDEO_ID,
	SOURCE_SHA,
} from '../../testing/prepared-track-view-fixtures';
import type {
	RaceVideoTrackViewPreparationRuntime,
	ReferenceFrameExtractionRuntime,
} from './race-video-media-container';
import {
	extractRaceVideoReferenceFrame,
	prepareRaceVideoTrackView,
	RaceVideoMediaContainer,
	validateRaceVideoMedia,
} from './race-video-media-container';
import {
	MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES,
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	raceVideoPlaybackContentType,
	raceVideoValidationResponseSchema,
} from './race-video-validation-contracts';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const VALIDATION_ID = '22222222-2222-4222-8222-222222222222';
const OBJECT_KEY = `race-recordings/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444/${RECORDING_ID}`;
const command = {
	recordingId: RECORDING_ID,
	validationId: VALIDATION_ID,
	objectKey: OBJECT_KEY,
	expectedByteCount: 3,
};

const accepted = raceVideoValidationResponseSchema.parse(acceptedFixture);
if (accepted.outcome !== 'accepted')
	throw new Error('Accepted validation fixture has the wrong outcome');
const media = accepted.media;
const rejected = raceVideoValidationResponseSchema.parse(rejectedFixture);

const preparationRequest = {
	contractVersion: 'subject-tracking.v1' as const,
	correlationId: CORRELATION_ID,
	caseId: RUN_ID,
	preparedMediaId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
	input: { stagedMediaId: RACE_VIDEO_ID, expectedByteCount: 100 },
	window: { startTimestampMs: 100, endTimestampMs: 400 },
	pipelineVersion: 'subject-tracking.v1' as const,
};

const preparationCommand = {
	request: preparationRequest,
	source: {
		objectKey: 'race-recordings/private/source',
		byteCount: 100,
		checksumSha256: SOURCE_SHA,
	},
	output: {
		mediaObjectKey: 'prepared/media.mp4',
		frameManifestObjectKey: 'prepared/manifest.json.gz',
	},
};

const jsonResponse = (value: unknown, init?: ResponseInit) =>
	new Response(JSON.stringify(value), {
		...init,
		headers: { 'content-type': 'application/json', ...init?.headers },
	});

const fixture = async () => {
	const r2 = new MockR2Controller();
	await r2.bucket.put(OBJECT_KEY, 'abc', {
		customMetadata: { recordingId: RECORDING_ID },
	});
	const start = vi.fn(async () => undefined);
	const stage = vi.fn(async (_path: string, body: ReadableStream) => {
		expect(await new Response(body).text()).toBe('abc');
		return 0;
	});
	const probe = vi.fn(async (_request: Request) => jsonResponse(accepted));
	return { r2, bucket: r2.bucket, start, stage, probe };
};

describe('Race-video media container adapter', () => {
	test('extracts and publishes a bounded private reference frame', async () => {
		const sourceKey =
			'race-recordings/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb/cccccccc-cccc-4ccc-8ccc-cccccccccccc';
		const output = new Map<string, Uint8Array>();
		const runtime = {
			bucket: {
				get: vi.fn(async (key: string) =>
					key === sourceKey
						? {
								size: 6,
								checksums: {
									toJSON: () => ({
										sha256:
											'41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d',
									}),
								},
								body: new ReadableStream({
									start(controller) {
										controller.enqueue(new TextEncoder().encode('source'));
										controller.close();
									},
								}),
							}
						: null,
				),
				put: vi.fn(async (key: string, body: Uint8Array) => {
					output.set(key, body);
				}),
			},
			start: vi.fn(async () => undefined),
			stage: vi.fn(async () => 0),
			extract: vi.fn(async () => ({
				body: new ReadableStream({
					start(controller) {
						controller.enqueue(Uint8Array.of(1, 2, 3));
						controller.close();
					},
				}),
				waitForExit: async () => 0,
			})),
			cleanup: vi.fn(async () => undefined),
		};
		await expect(
			extractRaceVideoReferenceFrame(
				{
					source: {
						objectKey: sourceKey,
						byteCount: 6,
						checksumSha256: '0'.repeat(64),
					},
					timestampMs: 250,
					outputObjectKey:
						'track-map-reference-frames/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
				},
				runtime as unknown as ReferenceFrameExtractionRuntime,
			),
		).rejects.toThrow('does not match frame input');

		const accepted = await extractRaceVideoReferenceFrame(
			{
				source: {
					objectKey: sourceKey,
					byteCount: 6,
					checksumSha256:
						'41cf6794ba4200b839c53531555f0f3998df4cbb01a4d5cb0b94e3ca5e23947d',
				},
				timestampMs: 250,
				outputObjectKey:
					'track-map-reference-frames/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb.jpg',
			},
			runtime as unknown as ReferenceFrameExtractionRuntime,
		);
		expect(accepted.byteCount).toBe(3);
		expect(accepted.contentType).toBe('image/jpeg');
		expect(runtime.extract).toHaveBeenCalledWith(
			expect.stringContaining('/var/lib/rc-mech/staged/reference-'),
			250,
		);
		expect(output.has(accepted.objectKey)).toBe(true);
		expect(runtime.cleanup).toHaveBeenCalledTimes(1);
	});

	test('stages, calls, streams, and cleans up a prepared Track view', async () => {
		const puts: Array<{ key: string; body: ReadableStream }> = [];
		const runtime = {
			bucket: {
				get: vi.fn(async () => ({
					size: 100,
					checksums: { toJSON: () => ({ sha256: SOURCE_SHA }) },
					body: new ReadableStream<Uint8Array>(),
				})),
				put: vi.fn(async (key: string, body: ReadableStream) => {
					puts.push({ key, body });
				}),
			},
			start: vi.fn(async () => undefined),
			stage: vi.fn(async () => 0),
			prepare: vi.fn(async () =>
				jsonResponse(
					prepareAcceptedFixture(
						'9'.repeat(64),
						preparationRequest.preparedMediaId,
						CORRELATION_ID,
					),
				),
			),
			stream: vi.fn(async () => ({
				body: new ReadableStream<Uint8Array>(),
				waitForExit: async () => 0,
			})),
			cleanup: vi.fn(async () => undefined),
		};
		await expect(
			prepareRaceVideoTrackView(
				preparationCommand,
				runtime as unknown as RaceVideoTrackViewPreparationRuntime,
			),
		).resolves.toMatchObject({ outcome: 'accepted' });
		expect(runtime.start).toHaveBeenCalledOnce();
		expect(runtime.stage).toHaveBeenCalledWith(
			'/var/lib/rc-mech/staged/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa.media',
			expect.any(ReadableStream),
		);
		expect(runtime.prepare).toHaveBeenCalledOnce();
		expect(puts.map(({ key }) => key)).toEqual([
			'prepared/media.mp4',
			'prepared/manifest.json.gz',
		]);
		expect(runtime.cleanup).toHaveBeenCalledOnce();
	});

	test('returns a safe service rejection without publishing artifacts', async () => {
		const runtime = {
			bucket: {
				get: vi.fn(async () => ({
					size: 100,
					checksums: { toJSON: () => ({ sha256: SOURCE_SHA }) },
					body: new ReadableStream<Uint8Array>(),
				})),
				put: vi.fn(),
			},
			start: vi.fn(async () => undefined),
			stage: vi.fn(async () => 0),
			prepare: vi.fn(async () =>
				jsonResponse({
					contractVersion: 'subject-tracking.v1',
					correlationId: CORRELATION_ID,
					outcome: 'rejected',
					caseId: RUN_ID,
					error: {
						code: 'SERVICE_BUSY',
						stage: 'admission',
						message: 'processing service is busy',
					},
				}),
			),
			stream: vi.fn(),
			cleanup: vi.fn(async () => undefined),
		};
		await expect(
			prepareRaceVideoTrackView(
				preparationCommand,
				runtime as unknown as RaceVideoTrackViewPreparationRuntime,
			),
		).resolves.toMatchObject({ outcome: 'rejected' });
		expect(runtime.bucket.put).not.toHaveBeenCalled();
		expect(runtime.stream).not.toHaveBeenCalled();
	});

	test('fails closed when the private source or prepared descriptor differs', async () => {
		const runtime = {
			bucket: {
				get: vi.fn(async () => ({
					size: 99,
					checksums: { toJSON: () => ({ sha256: SOURCE_SHA }) },
					body: new ReadableStream<Uint8Array>(),
				})),
			},
			start: vi.fn(async () => undefined),
			stage: vi.fn(),
			prepare: vi.fn(),
			stream: vi.fn(),
			cleanup: vi.fn(),
		};
		await expect(
			prepareRaceVideoTrackView(
				preparationCommand,
				runtime as unknown as RaceVideoTrackViewPreparationRuntime,
			),
		).rejects.toThrow('does not match preparation input');
		expect(runtime.stage).not.toHaveBeenCalled();

		const matching = {
			...runtime,
			bucket: {
				...runtime.bucket,
				get: vi.fn(async () => ({
					size: 100,
					checksums: { toJSON: () => ({ sha256: SOURCE_SHA }) },
					body: new ReadableStream<Uint8Array>(),
				})),
			},
			stage: vi.fn(async () => 0),
			prepare: vi.fn(async () =>
				jsonResponse({
					...prepareAcceptedFixture(
						'9'.repeat(64),
						preparationRequest.preparedMediaId,
					),
					prepared: {
						...preparedDescriptorFixture('9'.repeat(64)),
						sourceByteCount: 99,
					},
				}),
			),
			cleanup: vi.fn(async () => undefined),
		};
		await expect(
			prepareRaceVideoTrackView(
				preparationCommand,
				matching as unknown as RaceVideoTrackViewPreparationRuntime,
			),
		).rejects.toThrow('does not match preparation input');
		expect(matching.cleanup).toHaveBeenCalledOnce();
	});
	test('shares approved accepted and rejected fixtures with Python', () => {
		expect(accepted).toEqual(acceptedFixture);
		expect(rejected).toEqual(rejectedFixture);
	});

	test.each([
		[['matroska', 'webm'], 'video/webm'],
		[['mov', 'mp4'], 'video/mp4'],
		[['mov'], 'video/quicktime'],
		[['matroska'], null],
	] as const)(
		'derives trusted playback metadata from container formats %#',
		(containerFormats, expected) => {
			expect(
				raceVideoPlaybackContentType({
					...media,
					containerFormats: [...containerFormats],
				}),
			).toBe(expected);
		},
	);

	test('stages one trusted object and strictly parses the approved response', async () => {
		const value = await fixture();
		await expect(validateRaceVideoMedia(command, value)).resolves.toEqual(
			accepted,
		);
		expect(value.start).toHaveBeenCalledOnce();
		expect(value.stage).toHaveBeenCalledWith(
			`/var/lib/rc-mech/staged/${VALIDATION_ID}.media`,
			expect.any(ReadableStream),
		);
		const sent = value.probe.mock.calls[0]?.[0];
		if (!sent) throw new Error('Probe request was not captured');
		expect(sent.url).toBe('http://driving-analysis-media/v1/media/probe');
		const sentPayload = await sent.json();
		expect(sentPayload).toEqual({
			contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
			correlationId: VALIDATION_ID,
			input: { stagedMediaId: VALIDATION_ID, expectedByteCount: 3 },
		});
		expect(JSON.stringify(sentPayload)).not.toMatch(
			/objectKey|race-recordings|credential|client/i,
		);
	});

	test('returns stable safe storage and staging rejections', async () => {
		const missing = await fixture();
		missing.r2.objects.clear();
		await expect(
			validateRaceVideoMedia(command, missing),
		).resolves.toMatchObject({
			outcome: 'rejected',
			error: { code: 'STAGED_MEDIA_NOT_FOUND', stage: 'claim' },
		});
		expect(missing.stage).not.toHaveBeenCalled();

		for (const mutate of [
			(value: Awaited<ReturnType<typeof fixture>>) => {
				const stored = value.r2.objects.get(OBJECT_KEY);
				if (stored) stored.customMetadata = { recordingId: VALIDATION_ID };
			},
			(value: Awaited<ReturnType<typeof fixture>>) => {
				const stored = value.r2.objects.get(OBJECT_KEY);
				if (stored) stored.bytes = Uint8Array.of(1, 2);
			},
		]) {
			const mismatch = await fixture();
			mutate(mismatch);
			await expect(
				validateRaceVideoMedia(command, mismatch),
			).resolves.toMatchObject({
				outcome: 'rejected',
				error: { code: 'STAGED_MEDIA_MISMATCH', stage: 'claim' },
			});
		}

		const stageFailure = await fixture();
		stageFailure.stage.mockResolvedValueOnce(1);
		await expect(
			validateRaceVideoMedia(command, stageFailure),
		).resolves.toMatchObject({
			outcome: 'rejected',
			error: { code: 'INTERNAL_ERROR', stage: 'request' },
		});
		expect(stageFailure.probe).not.toHaveBeenCalled();
	});

	test('rejects malformed, unsafe, oversized, and stale service responses', async () => {
		const cases: readonly (() => Response | Promise<Response>)[] = [
			() =>
				new Response('{}', {
					status: 503,
					headers: { 'content-type': 'application/json' },
				}),
			() => new Response('{}', { headers: { 'content-type': 'text/plain' } }),
			() =>
				new Response('{}', {
					headers: {
						'content-type': 'application/json',
						'content-length': 'invalid',
					},
				}),
			() =>
				new Response('{}', {
					headers: {
						'content-type': 'application/json',
						'content-length': String(
							MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES + 1,
						),
					},
				}),
			() =>
				new Response('x'.repeat(MAX_RACE_VIDEO_VALIDATION_RESPONSE_BYTES + 1), {
					headers: { 'content-type': 'application/json' },
				}),
			() =>
				new Response(null, { headers: { 'content-type': 'application/json' } }),
			() =>
				new Response(Uint8Array.of(0xff), {
					headers: { 'content-type': 'application/json' },
				}),
			() => jsonResponse({ ...accepted, contractVersion: 'unknown.v1' }),
			() => jsonResponse({ ...accepted, correlationId: RECORDING_ID }),
			() => jsonResponse({ ...accepted, media: { ...media, byteCount: 2 } }),
			() =>
				jsonResponse({
					contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
					correlationId: null,
					outcome: 'rejected',
					error: {
						code: 'INVALID_REQUEST',
						stage: 'request',
						message: 'Invalid.',
					},
				}),
		];
		for (const response of cases) {
			const value = await fixture();
			value.probe.mockImplementationOnce(async () => response());
			await expect(validateRaceVideoMedia(command, value)).resolves.toEqual({
				contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
				correlationId: VALIDATION_ID,
				outcome: 'rejected',
				error: {
					code: 'INTERNAL_ERROR',
					stage: 'request',
					message:
						'The media validation service could not complete validation.',
				},
			});
		}
	});

	test('accepts a safe Python rejection and contains runtime failures', async () => {
		const value = await fixture();
		value.probe.mockResolvedValueOnce(jsonResponse(rejected));
		await expect(validateRaceVideoMedia(command, value)).resolves.toEqual(
			rejected,
		);

		const unavailable = await fixture();
		unavailable.start.mockRejectedValueOnce(new Error('private detail'));
		await expect(
			validateRaceVideoMedia(command, unavailable),
		).resolves.toMatchObject({ error: { code: 'INTERNAL_ERROR' } });
		await expect(
			validateRaceVideoMedia(
				{ ...command, validationId: 'invalid' },
				unavailable,
			),
		).rejects.toThrow();
	});

	test('container RPC uses fixed startup, exec, user, and internal-port settings', async () => {
		const value = await fixture();
		const exec = vi.fn(async () => ({ exitCode: Promise.resolve(0) }));
		const configured = new RaceVideoMediaContainer(
			{
				container: { running: false },
				storage: {
					kv: { get: () => undefined },
					sql: { exec: () => [] },
					setAlarm: async () => undefined,
					sync: async () => undefined,
				},
				blockConcurrencyWhile: (callback: () => Promise<unknown>) => {
					void callback();
				},
			} as unknown as DurableObjectState,
			{ ANALYSIS_MEDIA: value.r2.bucket },
		);
		expect(configured.defaultPort).toBe(8080);
		expect(configured.requiredPorts).toEqual([8080]);
		expect(configured.sleepAfter).toBe('5m');
		expect(configured.enableInternet).toBe(false);
		expect(configured.pingEndpoint).toBe('driving-analysis-media/health');
		const instance = Object.create(
			RaceVideoMediaContainer.prototype,
		) as RaceVideoMediaContainer;
		Object.assign(instance as unknown as Record<string, unknown>, {
			env: { ANALYSIS_MEDIA: value.r2.bucket },
			ctx: { container: { exec } },
			startAndWaitForPorts: value.start,
			containerFetch: value.probe,
		});
		await expect(instance.validateRaceVideo(command)).resolves.toEqual(
			accepted,
		);
		expect(value.start).toHaveBeenCalledWith({
			ports: 8080,
			cancellationOptions: {
				instanceGetTimeoutMS: 30_000,
				portReadyTimeoutMS: 30_000,
				waitInterval: 250,
			},
		});
		expect(exec).toHaveBeenCalledWith(
			['/usr/bin/tee', `/var/lib/rc-mech/staged/${VALIDATION_ID}.media`],
			expect.objectContaining({
				stdin: expect.any(ReadableStream),
				stdout: 'ignore',
				stderr: 'ignore',
				user: '10001:10001',
			}),
		);

		Object.assign(instance as unknown as Record<string, unknown>, {
			ctx: { container: undefined },
		});
		await expect(instance.validateRaceVideo(command)).resolves.toMatchObject({
			error: { code: 'INTERNAL_ERROR' },
		});
	});
});
