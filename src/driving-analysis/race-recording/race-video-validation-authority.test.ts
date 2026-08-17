import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { MockD1Controller, MockR2Controller } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { RaceRecordingAuthority } from './race-recording-authority';
import { RaceVideoValidationAuthority } from './race-video-validation-authority';
import {
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationResponse,
} from './race-video-validation-contracts';

const RECORDING_ID = '11111111-1111-4111-8111-111111111111';
const SECOND_RECORDING_ID = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-08-17T10:00:00.000Z';
const migrations = readdirSync(
	resolve(dirname(fileURLToPath(import.meta.url)), '../../../migrations'),
)
	.filter((name) => /^\d+.*\.sql$/.test(name))
	.sort()
	.map((name) =>
		readFileSync(
			resolve(
				dirname(fileURLToPath(import.meta.url)),
				'../../../migrations',
				name,
			),
			'utf8',
		),
	)
	.join('\n');

const media = {
	byteCount: 3,
	durationMs: 1000,
	width: 1920,
	height: 1080,
	videoCodec: 'h264',
	audioCodecs: ['aac'],
	containerFormats: ['mov', 'mp4'],
	decodedFrameCount: 60,
	averageFrameRate: { numerator: 60, denominator: 1 },
	timeBase: { numerator: 1, denominator: 60 },
	sampleAspectRatio: { numerator: 1, denominator: 1 },
	displayAspectRatio: { numerator: 16, denominator: 9 },
	startTimeMs: 0,
	checksumSha256: 'a'.repeat(64),
};

const accepted: RaceVideoValidationResponse = {
	contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	correlationId: RECORDING_ID,
	outcome: 'accepted',
	media,
};

let sqlite: SqliteD1Fixture;
let authority: RaceVideoValidationAuthority;

const seedRecording = (id: string, driveId: string, status = 'validating') => {
	const actualSize = status === 'validating' ? '3' : 'NULL';
	const completedAt = status === 'validating' ? `'${NOW}'` : 'NULL';
	sqlite.exec(`
    INSERT INTO drive_session (id, car_id, started_at)
    VALUES ('${driveId}', 'car-1', '${NOW}');
    INSERT INTO race_video (
      id, owner_id, car_id, drive_session_id, request_id, object_key,
      multipart_upload_id, file_name, content_type, declared_size, actual_size,
      part_size, status, created_at, updated_at, expires_at, completed_at
    ) VALUES (
			'${id}', 'owner-1', 'car-1', '${driveId}', 'request-${id}',
      'race-recordings/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444/${id}',
			'upload-${id}', 'Race.mp4', 'video/mp4', 3, ${actualSize}, 10485760,
			'${status}', '${NOW}', '${NOW}', '2026-08-24T10:00:00.000Z', ${completedAt}
    );
  `);
};

beforeEach(() => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	sqlite.exec(`
		INSERT INTO owner (id, name, email, email_verified, created_at, updated_at, timezone)
    VALUES ('owner-1', 'Owner', 'owner@example.com', 1, 0, 0, 'UTC');
    INSERT INTO car (id, owner_id, name, created_at)
    VALUES ('car-1', 'owner-1', 'Buggy', '${NOW}');
  `);
	seedRecording(RECORDING_ID, 'drive-1');
	authority = new RaceVideoValidationAuthority(sqlite.database);
});

afterEach(() => sqlite.close());

describe('RaceVideoValidationAuthority', () => {
	test('idempotently creates one fenced pending validation context', async () => {
		const payload = await authority.ensure(RECORDING_ID, NOW);
		expect(payload).toEqual({
			ownerId: 'owner-1',
			recordingId: RECORDING_ID,
			validationId: RECORDING_ID,
			expectedStateVersion: 1,
		});
		expect(await authority.ensure(RECORDING_ID, 'later')).toEqual(payload);
		expect(await authority.context(payload)).toEqual({
			kind: 'pending',
			ownerId: 'owner-1',
			recordingId: RECORDING_ID,
			validationId: RECORDING_ID,
			stateVersion: 1,
			objectKey: expect.stringContaining(`/${RECORDING_ID}`),
			expectedByteCount: 3,
		});
		expect(
			await authority.context({ ...payload, ownerId: 'other-owner' }),
		).toEqual({ kind: 'stale' });
		expect(
			await authority.context({
				...payload,
				validationId: SECOND_RECORDING_ID,
			}),
		).toEqual({ kind: 'stale' });
		expect(
			await authority.context({ ...payload, expectedStateVersion: 2 }),
		).toEqual({ kind: 'stale' });
	});

	test('publishes immutable accepted facts and fences replays and stale writes', async () => {
		const payload = await authority.ensure(RECORDING_ID, NOW);
		await expect(
			authority.publish(payload, accepted, '2026-08-17T10:01:00.000Z'),
		).resolves.toBe('published');
		expect(await authority.public(RECORDING_ID)).toEqual({
			status: 'ready',
			stateVersion: 2,
			media,
			error: null,
			validatedAt: '2026-08-17T10:01:00.000Z',
		});
		expect(await authority.context(payload)).toEqual({
			kind: 'terminal',
			status: 'ready',
		});
		expect(
			await authority.publish(payload, accepted, '2026-08-17T10:02:00.000Z'),
		).toBe('replayed');
		expect(
			await authority.publish(
				{ ...payload, validationId: SECOND_RECORDING_ID },
				accepted,
				'2026-08-17T10:02:00.000Z',
			),
		).toBe('stale');
		await expect(
			sqlite.database
				.prepare(
					"UPDATE race_video_validation SET status = 'invalid', state_version = 3 WHERE race_video_id = ?",
				)
				.bind(RECORDING_ID)
				.run(),
		).rejects.toThrow('terminal state is immutable');
	});

	test('publishes only strict safe rejected results', async () => {
		seedRecording(SECOND_RECORDING_ID, 'drive-2');
		const payload = await authority.ensure(SECOND_RECORDING_ID, NOW);
		const response: RaceVideoValidationResponse = {
			contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
			correlationId: SECOND_RECORDING_ID,
			outcome: 'rejected',
			error: {
				code: 'CORRUPT_MEDIA',
				stage: 'probe',
				message: 'The recording is corrupt.',
			},
		};
		expect(
			await authority.publish(payload, response, '2026-08-17T10:01:00.000Z'),
		).toBe('published');
		expect(await authority.public(SECOND_RECORDING_ID)).toEqual({
			status: 'invalid',
			stateVersion: 2,
			media: null,
			error: response.error,
			validatedAt: '2026-08-17T10:01:00.000Z',
		});
		expect(await authority.public('missing')).toBeNull();
	});

	test('rejects invalid parent creation and stale publication after deletion starts', async () => {
		seedRecording(SECOND_RECORDING_ID, 'drive-2', 'uploading');
		await expect(authority.ensure(SECOND_RECORDING_ID, NOW)).rejects.toThrow();
		const payload = await authority.ensure(RECORDING_ID, NOW);
		sqlite.exec(
			`UPDATE race_video SET status = 'deleting' WHERE id = '${RECORDING_ID}';`,
		);
		expect(await authority.context(payload)).toEqual({ kind: 'stale' });
		expect(
			await authority.publish(payload, accepted, '2026-08-17T10:01:00.000Z'),
		).toBe('stale');
	});

	test('detects active analyses without treating terminal runs as active', async () => {
		expect(await authority.hasActiveAnalysis(RECORDING_ID)).toBe(false);
		const payload = await authority.ensure(RECORDING_ID, NOW);
		await authority.publish(payload, accepted, '2026-08-17T10:01:00.000Z');
		sqlite.exec(`
      INSERT INTO inference_profile (
        profile_digest, contract_version, canonicalization_version,
        configuration_json, created_at
      ) VALUES ('${'a'.repeat(64)}', 'inference-profile.v1', 'canonical-json.v1', '{}', '${NOW}');
      INSERT INTO tracking_run (
        id, analysis_id, owner_id, run_sequence, workflow_id, profile_digest,
        input_digest, status, version, created_at
      ) VALUES (
        'run-1', 'analysis-1', 'owner-1', 1, 'workflow-1', '${'a'.repeat(64)}',
        '${'b'.repeat(64)}', 'active', 1, '${NOW}'
      );
      INSERT INTO tracking_run_input (
        run_id, owner_id, race_video_id, source_object_key, source_byte_count,
        source_checksum, window_start_timestamp_ms, window_end_timestamp_ms,
        approved_track_map_version_id, source_layout_version,
        source_layout_digest, source_width, source_height, input_digest, created_at
      ) VALUES (
			'run-1', 'owner-1', '${RECORDING_ID}',
			'race-recordings/33333333-3333-4333-8333-333333333333/44444444-4444-4444-8444-444444444444/${RECORDING_ID}',
			3, '${'a'.repeat(64)}', 0, 1000, 'map-1', 'layout.v1',
        '${'d'.repeat(64)}', 1920, 1080, '${'b'.repeat(64)}', '${NOW}'
      );
    `);
		expect(await authority.hasActiveAnalysis(RECORDING_ID)).toBe(true);
		await expect(
			new RaceRecordingAuthority(
				sqlite.database,
				new MockR2Controller().bucket,
			).remove({ ownerId: 'owner-1', recordingId: RECORDING_ID }),
		).rejects.toMatchObject({
			code: 'CONFLICT',
			message: 'Race recording cannot be deleted during an active analysis',
		});
		sqlite.exec(
			"UPDATE tracking_run SET status = 'completed' WHERE id = 'run-1';",
		);
		expect(await authority.hasActiveAnalysis(RECORDING_ID)).toBe(false);
	});

	test('fails closed when persistence vanishes after an idempotent insert', async () => {
		const d1 = new MockD1Controller();
		d1.queue({ kind: 'run' }, { kind: 'first', value: null });
		await expect(
			new RaceVideoValidationAuthority(d1.database).ensure(RECORDING_ID, NOW),
		).rejects.toThrow('could not be persisted');
		d1.expectConsumed();
	});

	test('does not publish malformed stored facts or unsafe stored errors', async () => {
		const malformedReadyId = '33333333-3333-4333-8333-333333333333';
		const unsafeErrorId = '44444444-4444-4444-8444-444444444444';
		seedRecording(malformedReadyId, 'drive-3');
		seedRecording(unsafeErrorId, 'drive-4');
		sqlite.exec(`
			INSERT INTO race_video_validation (
				race_video_id, validation_id, status, state_version, byte_count,
				duration_ms, width, height, video_codec, audio_codecs_json,
				container_formats_json, decoded_frame_count,
				average_frame_rate_numerator, average_frame_rate_denominator,
				time_base_numerator, time_base_denominator,
				sample_aspect_ratio_numerator, sample_aspect_ratio_denominator,
				display_aspect_ratio_numerator, display_aspect_ratio_denominator,
				start_time_ms, checksum_sha256, started_at, updated_at, completed_at
			) VALUES (
				'${malformedReadyId}', '${malformedReadyId}', 'ready', 2, 3,
				1000, 1920, 1080, 'h264', '[1]', '{bad', 60,
				60, 1, 1, 60, 1, 1, 16, 9, 0, '${'a'.repeat(64)}',
				'${NOW}', '${NOW}', '${NOW}'
			);
			INSERT INTO race_video_validation (
				race_video_id, validation_id, status, state_version, error_code,
				error_stage, error_message, started_at, updated_at, completed_at
			) VALUES (
				'${unsafeErrorId}', '${unsafeErrorId}', 'invalid', 2,
				'CORRUPT_MEDIA', 'probe', 'See https://private.invalid',
				'${NOW}', '${NOW}', '${NOW}'
			);
		`);
		expect(await authority.public(malformedReadyId)).toMatchObject({
			status: 'ready',
			media: null,
		});
		expect(await authority.public(unsafeErrorId)).toMatchObject({
			status: 'invalid',
			error: null,
		});
	});
});
