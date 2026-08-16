import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, test } from 'vitest';
import {
	inferenceProfileFixture,
	RUN_ID,
} from '../../testing/driving-analysis-tracking-fixtures';
import {
	PREPARED_MEDIA_ID,
	preparedDescriptorFixture,
	preparedObjectsFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import { trackingAuthoritySchema, trackingRunInput } from './authority-schema';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import {
	TrackingAuthority,
	TrackingAuthorityError,
} from './tracking-authority';
import { digestTrackingRunInput } from './tracking-run-input';

const OWNER_ID = 'owner-1';
const NOW = '2026-08-16T20:00:00.000Z';
const DELETE_AFTER = '2026-08-17T20:00:00.000Z';
const DELETED_AT = '2026-08-18T20:01:00.000Z';

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const migrations = [
	'0019_tracking_authority.sql',
	'0020_immutable_track_view.sql',
]
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

const authorityFixture = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const tracking = new TrackingAuthority(sqlite.database);
	const authority = new PreparedTrackViewAuthority(sqlite.database);
	const input = trackingRunInputFixture();
	const inputDigest = await digestTrackingRunInput(input);
	await tracking.createRun({
		runId: RUN_ID,
		analysisId: 'analysis-1',
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: 'workflow-1',
		profile: inferenceProfileFixture(),
		inputDigest,
		createdAt: NOW,
	});
	return { authority, tracking, input, inputDigest };
};

const pinnedAuthorityFixture = async () => {
	const value = await authorityFixture();
	await value.authority.pinRunInput({
		ownerId: OWNER_ID,
		input: value.input,
		createdAt: NOW,
	});
	return value;
};

const acceptCommand = (inputDigest: string) => ({
	ownerId: OWNER_ID,
	runId: RUN_ID,
	expectedRunVersion: 1,
	expectedInputDigest: inputDigest,
	descriptor: preparedDescriptorFixture(inputDigest),
	objects: preparedObjectsFixture(),
	deleteAfter: DELETE_AFTER,
	createdAt: NOW,
});

const expectAuthorityError = async (
	promise: Promise<unknown>,
	code: TrackingAuthorityError['code'],
) => {
	await expect(promise).rejects.toMatchObject({
		name: 'TrackingAuthorityError',
		code,
	});
};

describe('PreparedTrackViewAuthority', () => {
	test('pins one immutable owned Race window and approved Track-map layout', async () => {
		const { authority, input, inputDigest } = await authorityFixture();
		await expectAuthorityError(
			authority.preparationContext(OWNER_ID, RUN_ID),
			'NOT_FOUND',
		);
		const command = { ownerId: OWNER_ID, input, createdAt: NOW };
		const pinned = await authority.pinRunInput(command);
		expect(pinned).toMatchObject({
			runId: RUN_ID,
			ownerId: OWNER_ID,
			raceVideoId: input.raceVideoId,
			approvedTrackMapVersionId: input.approvedTrackMapVersionId,
			inputDigest,
		});
		expect(await authority.pinRunInput(command)).toEqual(pinned);

		await expectAuthorityError(
			authority.pinRunInput({ ...command, createdAt: DELETE_AFTER }),
			'CONFLICT',
		);
		await expectAuthorityError(
			authority.preparationContext('another-owner', RUN_ID),
			'NOT_FOUND',
		);
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const database = drizzle(sqlite.database, {
			schema: trackingAuthoritySchema,
		});
		await expect(
			database
				.update(trackingRunInput)
				.set({ sourceObjectKey: 'changed' })
				.where(eq(trackingRunInput.runId, RUN_ID)),
		).rejects.toMatchObject({
			cause: { message: 'tracking_run_input is immutable' },
		});
		await expect(
			database
				.delete(trackingRunInput)
				.where(eq(trackingRunInput.runId, RUN_ID)),
		).rejects.toMatchObject({
			cause: { message: 'tracking_run_input is immutable' },
		});
	});

	test('rejects pinning when the run digest or lifecycle authority is stale', async () => {
		const first = await authorityFixture();
		await expectAuthorityError(
			first.authority.pinRunInput({
				ownerId: OWNER_ID,
				input: trackingRunInputFixture({
					sourceChecksumSha256: 'f'.repeat(64),
				}),
				createdAt: NOW,
			}),
			'STALE_AUTHORITY',
		);
		await first.tracking.fenceRun({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			expectedVersion: 1,
			status: 'cancelled',
			completedAt: DELETE_AFTER,
		});
		await expectAuthorityError(
			first.authority.pinRunInput({
				ownerId: OWNER_ID,
				input: first.input,
				createdAt: NOW,
			}),
			'STALE_AUTHORITY',
		);
	});

	test('atomically accepts exactly one descriptor and its two private objects', async () => {
		const { authority, inputDigest } = await pinnedAuthorityFixture();
		expect(
			(await authority.preparationContext(OWNER_ID, RUN_ID)).accepted,
		).toBe(null);
		expect(
			await authority.isAcceptedCandidate(OWNER_ID, RUN_ID, PREPARED_MEDIA_ID),
		).toBe(false);
		const command = acceptCommand(inputDigest);
		const accepted = await authority.acceptPreparedTrackView(command);
		expect(accepted.descriptor).toEqual(command.descriptor);
		expect(accepted.objects.map((object) => object.role)).toEqual([
			'frame-manifest',
			'prepared-media',
		]);
		expect(accepted.retention).toMatchObject({
			state: 'active',
			version: 1,
			deleteAfter: DELETE_AFTER,
		});
		expect(await authority.acceptPreparedTrackView(command)).toEqual(accepted);
		expect(
			await authority.isAcceptedCandidate(
				OWNER_ID,
				RUN_ID,
				accepted.descriptor.preparedMediaId,
			),
		).toBe(true);
		expect(
			await authority.isAcceptedCandidate(
				OWNER_ID,
				RUN_ID,
				'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
			),
		).toBe(false);

		await expectAuthorityError(
			authority.acceptPreparedTrackView({
				...command,
				deleteAfter: '2026-08-18T20:00:00.000Z',
			}),
			'CONFLICT',
		);
		await expectAuthorityError(
			authority.acceptPreparedTrackView({
				...command,
				objects: [command.objects[0], command.objects[0]],
			}),
			'CONFLICT',
		);
		await expectAuthorityError(
			authority.acceptPreparedTrackView({
				...command,
				descriptor: { ...command.descriptor, sourceByteCount: 101 },
			}),
			'STALE_AUTHORITY',
		);
		const conflictingId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
		await expectAuthorityError(
			authority.acceptPreparedTrackView({
				...command,
				descriptor: preparedDescriptorFixture(inputDigest, conflictingId),
				objects: preparedObjectsFixture(conflictingId),
			}),
			'CONFLICT',
		);
	});

	test('exposes only due terminal cleanup and records one monotonic deletion', async () => {
		const { authority, tracking, inputDigest } = await pinnedAuthorityFixture();
		const accepted = await authority.acceptPreparedTrackView(
			acceptCommand(inputDigest),
		);
		expect(await authority.cleanupCandidates(DELETED_AT, DELETE_AFTER)).toEqual(
			[],
		);
		await expectAuthorityError(
			authority.markDeleted({
				ownerId: OWNER_ID,
				runId: RUN_ID,
				preparedMediaId: accepted.descriptor.preparedMediaId,
				expectedVersion: 1,
				deletedAt: DELETED_AT,
			}),
			'STALE_AUTHORITY',
		);
		await tracking.fenceRun({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			expectedVersion: 1,
			status: 'failed',
			completedAt: DELETE_AFTER,
		});
		expect(
			await authority.cleanupCandidates(
				'2026-08-17T20:01:00.000Z',
				'2026-08-16T20:01:00.000Z',
			),
		).toEqual([]);
		const [candidate] = await authority.cleanupCandidates(
			DELETED_AT,
			DELETE_AFTER,
			1,
		);
		expect(candidate).toMatchObject({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			preparedMediaId: accepted.descriptor.preparedMediaId,
			version: 1,
		});
		const command = {
			ownerId: OWNER_ID,
			runId: RUN_ID,
			preparedMediaId: accepted.descriptor.preparedMediaId,
			expectedVersion: 1,
			deletedAt: DELETED_AT,
		};
		const deleted = await authority.markDeleted(command);
		expect(deleted).toMatchObject({ state: 'deleted', version: 2 });
		expect(await authority.markDeleted(command)).toEqual(deleted);
		expect(await authority.cleanupCandidates(DELETED_AT, DELETE_AFTER)).toEqual(
			[],
		);
		await expectAuthorityError(
			authority.markDeleted({ ...command, expectedVersion: 2 }),
			'STALE_AUTHORITY',
		);
		await expect(
			authority.cleanupCandidates(DELETED_AT, DELETE_AFTER, 0),
		).rejects.toThrow(RangeError);
		await expect(
			authority.cleanupCandidates(DELETED_AT, DELETE_AFTER, 101),
		).rejects.toThrow(RangeError);
		await expect(
			authority.cleanupCandidates(DELETED_AT, DELETE_AFTER, 1.5),
		).rejects.toThrow(RangeError);
	});
});
