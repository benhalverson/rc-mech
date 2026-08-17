import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, describe, expect, test, vi } from 'vitest';
import {
	authRateLimit,
	car,
	driveSession,
	owner,
	raceVideo,
	raceVideoUploadPart,
} from '../../schema';
import { MockR2Controller } from '../../testing/hono-fixture';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import {
	RaceRecordingAuthority,
	RaceRecordingAuthorityError,
} from './race-recording-authority';
import {
	MAX_ACTIVE_RACE_RECORDINGS_PER_OWNER,
	MAX_RACE_RECORDING_CREATIONS_PER_HOUR,
	RACE_RECORDING_PART_SIZE,
} from './race-recording-contracts';

const OWNER_ID = 'owner-1';
const CAR_ID = 'car-1';
const DRIVE_ID = 'drive-1';
const NOW = new Date('2026-08-16T20:00:00.000Z');

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const raceRecordingMigration = readFileSync(
	resolve(migrationDirectory, '0021_resumable_race_recording.sql'),
	'utf8',
);
const migrations = readdirSync(migrationDirectory)
	.filter((name) => /^\d+.*\.sql$/.test(name))
	.sort()
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
	vi.restoreAllMocks();
});

const seedCore = async (database: D1Database) => {
	const orm = drizzle(database);
	await orm.insert(owner).values({
		id: OWNER_ID,
		name: 'Owner',
		email: 'owner@example.com',
		emailVerified: true,
		createdAt: NOW,
		updatedAt: NOW,
		timezone: 'UTC',
	});
	await orm.insert(car).values({
		id: CAR_ID,
		ownerId: OWNER_ID,
		name: 'Buggy',
		createdAt: NOW.toISOString(),
	});
	await orm.insert(driveSession).values({
		id: DRIVE_ID,
		carId: CAR_ID,
		startedAt: NOW.toISOString(),
	});
};

const authorityFixture = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	await seedCore(sqlite.database);
	const r2 = new MockR2Controller();
	let now = NOW;
	let nextId = 0;
	let nextClaimId = 0;
	const authority = new RaceRecordingAuthority(sqlite.database, r2.bucket, {
		clock: () => now,
		id: () => `opaque-${++nextId}`,
		claimId: () => `claim-${++nextClaimId}`,
	});
	return {
		authority,
		r2,
		database: drizzle(sqlite.database),
		setNow: (value: Date) => {
			now = value;
		},
	};
};

const createCommand = (driveSessionId = DRIVE_ID) => ({
	ownerId: OWNER_ID,
	carId: CAR_ID,
	driveSessionId,
	input: {
		fileName: 'Main race.mov',
		contentType: 'video/quicktime' as const,
		sizeBytes: RACE_RECORDING_PART_SIZE + 3,
		requestId: `request-${driveSessionId}`,
	},
});

const identity = (recordingId: string) => ({
	ownerId: OWNER_ID,
	recordingId,
});

const streamingPart = (bytes: ArrayBuffer) => ({
	body: new Blob([bytes]).stream(),
	byteCount: bytes.byteLength,
});

const expectCode = async (
	promise: Promise<unknown>,
	code: RaceRecordingAuthorityError['code'],
) => {
	await expect(promise).rejects.toMatchObject({
		name: 'RaceRecordingAuthorityError',
		code,
	});
};

const deferred = () => {
	let resolve!: () => void;
	const promise = new Promise<void>((next) => {
		resolve = next;
	});
	return { promise, resolve };
};

const withoutReturningRows = (
	statement: D1PreparedStatement,
	beforeRaw: () => Promise<void> = async () => undefined,
): D1PreparedStatement => {
	let bound = statement;
	const empty = {
		bind: (...values: unknown[]) => {
			bound = statement.bind(...values);
			return empty;
		},
		first: <T = Record<string, unknown>>(columnName?: string) =>
			bound.first<T>(columnName),
		run: <T = Record<string, unknown>>() => bound.run<T>(),
		all: <T = Record<string, unknown>>() => bound.all<T>(),
		raw: async <T = unknown[]>() => {
			await beforeRaw();
			return [] as T[];
		},
	} as D1PreparedStatement;
	return empty;
};

const withoutSelectionRows = (
	statement: D1PreparedStatement,
): D1PreparedStatement => {
	const hidden = withoutReturningRows(statement);
	return Object.assign(hidden, {
		first: async <T = Record<string, unknown>>() => null as T | null,
	});
};

describe('RaceRecordingAuthority', () => {
	test('keeps quota triggers compatible with the remote D1 migration parser', () => {
		const quotaTrigger = raceRecordingMigration.split(
			'CREATE TRIGGER race_video_owner_quota',
		)[1];
		expect(quotaTrigger).not.toContain('CASE');
		expect(
			quotaTrigger?.match(
				/SELECT RAISE\(ABORT, 'race_video owner quota exceeded'\) WHERE/g,
			),
		).toHaveLength(3);
	});

	test('uses Worker time and UUID capabilities by default', async () => {
		sqlite = createSqliteD1();
		sqlite.exec(migrations);
		await seedCore(sqlite.database);
		const r2 = new MockR2Controller();
		const authority = new RaceRecordingAuthority(sqlite.database, r2.bucket);
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		expect(recording.id).toMatch(
			/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
		);
		await expect(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'default-claim',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
		).resolves.toMatchObject({ uploadedBytes: 1 });
	});

	test('creates, resumes, replaces parts, completes, and replays one private Race recording', async () => {
		const { authority, r2 } = await authorityFixture();
		const created = await authority.create(createCommand());
		expect(created.created).toBe(true);
		expect(created.recording).toMatchObject({
			id: 'opaque-1',
			driveSessionId: DRIVE_ID,
			fileName: 'Main race.mov',
			status: 'uploading',
			uploadedBytes: 0,
		});
		expect(JSON.stringify(created.recording)).not.toContain('objectKey');
		expect(JSON.stringify(created.recording)).not.toContain('multipart');
		expect(r2.multipartUploads.size).toBe(1);
		expect([...r2.multipartUploads.values()][0]?.key).toBe(
			'race-recordings/opaque-2/opaque-3/opaque-1',
		);
		expect(await authority.get(OWNER_ID, created.recording.id)).toEqual(
			created.recording,
		);

		const resumed = await authority.create(createCommand());
		expect(resumed).toEqual({ recording: created.recording, created: false });
		expect(
			await authority.create({
				...createCommand(),
				input: {
					...createCommand().input,
					requestId: 'request-after-browser-restart',
				},
			}),
		).toEqual({ recording: created.recording, created: false });
		await expectCode(
			authority.create({
				...createCommand(),
				input: { ...createCommand().input, fileName: 'Different.mov' },
			}),
			'CONFLICT',
		);

		const firstBytes = new Uint8Array(RACE_RECORDING_PART_SIZE).buffer;
		let progress = await authority.uploadPart({
			...identity(created.recording.id),
			partNumber: 1,
			transferRequestId: 'transfer-1',
			...streamingPart(firstBytes),
		});
		expect(progress.uploadedBytes).toBe(RACE_RECORDING_PART_SIZE);
		expect(progress.uploadedPartNumbers).toEqual([1]);

		progress = await authority.uploadPart({
			...identity(created.recording.id),
			partNumber: 1,
			transferRequestId: 'transfer-1',
			...streamingPart(firstBytes),
		});
		expect(progress.uploadedPartNumbers).toHaveLength(1);
		progress = await authority.uploadPart({
			...identity(created.recording.id),
			partNumber: 1,
			transferRequestId: 'replacement-1',
			...streamingPart(firstBytes),
		});
		expect(progress.uploadedPartNumbers).toHaveLength(1);

		await expectCode(
			authority.complete(identity(created.recording.id)),
			'CONFLICT',
		);
		progress = await authority.uploadPart({
			...identity(created.recording.id),
			partNumber: 2,
			transferRequestId: 'transfer-2',
			...streamingPart(Uint8Array.of(1, 2, 3).buffer),
		});
		expect(progress.uploadedBytes).toBe(RACE_RECORDING_PART_SIZE + 3);
		const head = vi.spyOn(r2.bucket, 'head');
		const completed = await authority.complete(identity(created.recording.id));
		expect(completed).toMatchObject({
			status: 'validating',
			uploadedBytes: RACE_RECORDING_PART_SIZE + 3,
			completedAt: NOW.toISOString(),
		});
		expect(head).not.toHaveBeenCalled();
		expect(await authority.complete(identity(created.recording.id))).toEqual(
			completed,
		);
		await expectCode(
			authority.uploadPart({
				...identity(created.recording.id),
				partNumber: 2,
				transferRequestId: 'after-completion',
				...streamingPart(Uint8Array.of(1, 2, 3).buffer),
			}),
			'CONFLICT',
		);
		expect(r2.multipartUploads.size).toBe(0);
		expect([...r2.objects.values()][0]?.bytes.byteLength).toBe(
			RACE_RECORDING_PART_SIZE + 3,
		);
		expect(await authority.list(OWNER_ID, CAR_ID)).toEqual([completed]);
		await authority.remove(identity(created.recording.id));
		expect(r2.objects.size).toBe(0);
		expect(await authority.list(OWNER_ID, CAR_ID)).toEqual([]);
	});

	test.each(['missing', 'wrong-sized', 'wrong-metadata'] as const)(
		'rejects %s reconciliation witnesses and resets owned completion',
		async (kind) => {
			const { authority, database, r2 } = await authorityFixture();
			const { recording } = await authority.create({
				...createCommand(),
				input: { ...createCommand().input, sizeBytes: 1 },
			});
			await authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: `reconciliation-${kind}`,
				...streamingPart(Uint8Array.of(1).buffer),
			});
			let committed: R2Object | null = null;
			const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
			vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
				(key, uploadId) => {
					const multipart = resumed(key, uploadId);
					return {
						...multipart,
						complete: async (parts) => {
							committed = await multipart.complete(parts);
							return Object.assign(committed, { customMetadata: undefined });
						},
					};
				},
			);
			const head = vi.spyOn(r2.bucket, 'head').mockImplementation(async () => {
				if (kind === 'missing' || !committed) return null;
				if (kind === 'wrong-sized')
					return Object.assign(committed, { size: 999 });
				return Object.assign(committed, {
					customMetadata: { recordingId: 'different-recording' },
				});
			});

			await expectCode(
				authority.complete(identity(recording.id)),
				'STORAGE_UNAVAILABLE',
			);
			expect(head).toHaveBeenCalledTimes(1);
			expect(
				await database
					.select({ status: raceVideo.status })
					.from(raceVideo)
					.where(eq(raceVideo.id, recording.id))
					.get(),
			).toEqual({ status: 'uploading' });
		},
	);

	test('reconciles an object committed before multipart completion throws', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'post-commit-exception',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => {
				const multipart = resumed(key, uploadId);
				return {
					...multipart,
					complete: async (parts) => {
						await multipart.complete(parts);
						throw new Error('response lost after commit');
					},
				};
			},
		);
		const head = vi.spyOn(r2.bucket, 'head');

		await expect(
			authority.complete(identity(recording.id)),
		).resolves.toMatchObject({ status: 'validating' });
		expect(head).toHaveBeenCalledTimes(1);
	});

	test('maps a failed reconciliation lookup to storage unavailable', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'failed-reconciliation',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => ({
				...resumed(key, uploadId),
				complete: async () => null,
			}),
		);
		const head = vi
			.spyOn(r2.bucket, 'head')
			.mockRejectedValue(new Error('R2 unavailable'));

		await expectCode(
			authority.complete(identity(recording.id)),
			'STORAGE_UNAVAILABLE',
		);
		expect(head).toHaveBeenCalledTimes(1);
		expect(
			await database
				.select({ status: raceVideo.status })
				.from(raceVideo)
				.where(eq(raceVideo.id, recording.id))
				.get(),
		).toEqual({ status: 'uploading' });
	});

	test('rejects invalid, rewritten, missing, expired, and foreign part authority', async () => {
		const { authority, setNow } = await authorityFixture();
		const { recording } = await authority.create(createCommand());
		const bytes = new Uint8Array(RACE_RECORDING_PART_SIZE).buffer;
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 0,
				transferRequestId: 'zero',
				...streamingPart(bytes),
			}),
			'INVALID_PART',
		);
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'short',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'INVALID_PART',
		);
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'same-transfer',
			...streamingPart(bytes),
		});
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 2,
				transferRequestId: 'same-transfer',
				...streamingPart(Uint8Array.of(1, 2, 3).buffer),
			}),
			'CONFLICT',
		);
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				ownerId: 'another-owner',
				partNumber: 1,
				transferRequestId: 'foreign',
				...streamingPart(bytes),
			}),
			'NOT_FOUND',
		);
		await expect(
			authority.remove({
				...identity('missing'),
				ownerId: 'another-owner',
			}),
		).resolves.toBeUndefined();

		setNow(new Date('2026-08-24T20:00:00.000Z'));
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 2,
				transferRequestId: 'expired',
				...streamingPart(Uint8Array.of(1, 2, 3).buffer),
			}),
			'EXPIRED',
		);
		expect(await authority.list(OWNER_ID, CAR_ID)).toEqual([]);
	});

	test('serializes overlapping part retries before R2 can replace an ETag', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		const enteredR2 = deferred();
		const releaseR2 = deferred();
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => {
				const multipart = resumed(key, uploadId);
				return {
					...multipart,
					uploadPart: async (partNumber, body, options) => {
						enteredR2.resolve();
						await releaseR2.promise;
						return multipart.uploadPart(partNumber, body, options);
					},
				};
			},
		);
		const first = authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'stable-transfer',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		await enteredR2.promise;
		await expectCode(authority.complete(identity(recording.id)), 'CONFLICT');
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'stable-transfer',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'overlapping-transfer',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		releaseR2.resolve();
		await expect(first).resolves.toMatchObject({
			uploadedBytes: 1,
			uploadedPartNumbers: [1],
		});
	});

	test('reclaims a stale idempotent part transfer after Worker termination', async () => {
		const { authority, database, setNow } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await database.insert(raceVideoUploadPart).values({
			raceVideoId: recording.id,
			partNumber: 1,
			transferRequestId: null,
			status: 'uploading',
			claimId: 'terminated-worker',
			claimTransferRequestId: 'stable-transfer',
			etag: null,
			byteCount: 1,
			claimedAt: NOW.toISOString(),
			uploadedAt: null,
		});
		setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
		await expect(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'stable-transfer',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
		).resolves.toMatchObject({
			uploadedBytes: 1,
			uploadedPartNumbers: [1],
		});
	});

	test('releases a part claim when its uploading parent witness is gone', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const missingParent = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					return query.startsWith('select "id" from "race_video" where')
						? withoutReturningRows(statement)
						: statement;
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expectCode(
			missingParent.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'parent-race',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		expect(await database.select().from(raceVideoUploadPart)).toEqual([]);
	});

	test('restores the authoritative ETag when an R2 replacement fails', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'first-transfer',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => ({
				...resumed(key, uploadId),
				uploadPart: async () => {
					throw new Error('replacement failed');
				},
			}),
		);
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'replacement-transfer',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'STORAGE_UNAVAILABLE',
		);
		expect(await authority.get(OWNER_ID, recording.id)).toMatchObject({
			uploadedBytes: 1,
			uploadedPartNumbers: [1],
		});
	});

	test('fails closed when a part claim cannot be acquired or finalized', async () => {
		const { authority, r2, database } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const rejectingClaim = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					if (query.startsWith('insert into "race_video_upload_part"'))
						throw new Error('claim unavailable');
					return base.prepare(query);
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expectCode(
			rejectingClaim.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'rejected-claim',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		const emptyClaim = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					if (!query.startsWith('insert into "race_video_upload_part"'))
						return statement;
					return withoutReturningRows(statement);
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expectCode(
			emptyClaim.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'empty-claim',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);

		const enteredR2 = deferred();
		const releaseR2 = deferred();
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => {
				const multipart = resumed(key, uploadId);
				return {
					...multipart,
					uploadPart: async (partNumber, body, options) => {
						enteredR2.resolve();
						await releaseR2.promise;
						return multipart.uploadPart(partNumber, body, options);
					},
				};
			},
		);
		const lostClaim = authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'lost-claim',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		await enteredR2.promise;
		await database
			.delete(raceVideoUploadPart)
			.where(eq(raceVideoUploadPart.raceVideoId, recording.id));
		releaseR2.resolve();
		await expectCode(lostClaim, 'CONFLICT');
	});

	test('fences deletion while multipart completion owns the state transition', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'only-part',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		const enteredR2 = deferred();
		const releaseR2 = deferred();
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => {
				const multipart = resumed(key, uploadId);
				return {
					...multipart,
					complete: async (parts) => {
						enteredR2.resolve();
						await releaseR2.promise;
						return multipart.complete(parts);
					},
				};
			},
		);
		const completion = authority.complete(identity(recording.id));
		await enteredR2.promise;
		await expectCode(authority.remove(identity(recording.id)), 'CONFLICT');
		releaseR2.resolve();
		await expect(completion).resolves.toMatchObject({ status: 'validating' });
		await expect(
			authority.remove(identity(recording.id)),
		).resolves.toBeUndefined();
		expect(r2.objects.size).toBe(0);
	});

	test('replays concurrent completion through one claimed lifecycle', async () => {
		const { authority } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'completion-part',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		const results = await Promise.all([
			authority.complete(identity(recording.id)),
			authority.complete(identity(recording.id)),
		]);
		expect(results).toMatchObject([
			{ status: 'validating' },
			{ status: 'validating' },
		]);
	});

	test('reconciles completion when another request wins the D1 claim', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'completion-race-part',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const raced = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					return query.startsWith('update "race_video" set "status"')
						? withoutReturningRows(statement, async () => {
								await database
									.update(raceVideo)
									.set({
										status: 'validating',
										actualSize: 1,
										completedAt: NOW.toISOString(),
										updatedAt: NOW.toISOString(),
									})
									.where(eq(raceVideo.id, recording.id));
							})
						: statement;
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expect(raced.complete(identity(recording.id))).resolves.toMatchObject(
			{
				status: 'validating',
			},
		);
	});

	test('keeps non-owning completion attempts from resetting claimed state', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await database
			.update(raceVideo)
			.set({ status: 'completing' })
			.where(eq(raceVideo.id, recording.id));
		await expectCode(authority.complete(identity(recording.id)), 'CONFLICT');
		expect(
			await database
				.select({ status: raceVideo.status })
				.from(raceVideo)
				.where(eq(raceVideo.id, recording.id))
				.get(),
		).toEqual({ status: 'completing' });

		await database
			.update(raceVideo)
			.set({ status: 'uploading' })
			.where(eq(raceVideo.id, recording.id));
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'completion-part',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		await database
			.update(raceVideo)
			.set({ status: 'completing' })
			.where(eq(raceVideo.id, recording.id));
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => ({
				...resumed(key, uploadId),
				complete: async () => {
					throw new Error('still completing elsewhere');
				},
			}),
		);
		await expectCode(
			authority.complete(identity(recording.id)),
			'STORAGE_UNAVAILABLE',
		);
		expect(
			await database
				.select({ status: raceVideo.status })
				.from(raceVideo)
				.where(eq(raceVideo.id, recording.id))
				.get(),
		).toEqual({ status: 'completing' });

		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const lostFinalWitness = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					return query.startsWith('update "race_video" set') &&
						query.includes('"actual_size"')
						? withoutReturningRows(statement)
						: statement;
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expectCode(
			lostFinalWitness.complete(identity(recording.id)),
			'CONFLICT',
		);
	});

	test('binds creation replay to its Drive and client request identity', async () => {
		const { authority, database } = await authorityFixture();
		await database.insert(driveSession).values({
			id: 'drive-2',
			carId: CAR_ID,
			startedAt: NOW.toISOString(),
		});
		await authority.create(createCommand());
		await expectCode(
			authority.create({
				...createCommand('drive-2'),
				input: createCommand().input,
			}),
			'CONFLICT',
		);
	});

	test('enforces owner, active Drive-session, and active-upload quota boundaries', async () => {
		const { authority, database } = await authorityFixture();
		await expectCode(authority.list('another-owner', CAR_ID), 'NOT_FOUND');
		await expectCode(
			authority.create({ ...createCommand(), carId: 'missing' }),
			'NOT_FOUND',
		);
		await database
			.update(car)
			.set({ archivedAt: NOW.toISOString() })
			.where(eq(car.id, CAR_ID));
		await expectCode(authority.create(createCommand()), 'CONFLICT');
		await database
			.update(car)
			.set({ archivedAt: null })
			.where(eq(car.id, CAR_ID));
		await database
			.update(driveSession)
			.set({ deletedAt: NOW.toISOString() })
			.where(eq(driveSession.id, DRIVE_ID));
		await expectCode(authority.create(createCommand()), 'NOT_FOUND');
		await database
			.update(driveSession)
			.set({ deletedAt: null })
			.where(eq(driveSession.id, DRIVE_ID));

		for (
			let index = 1;
			index <= MAX_ACTIVE_RACE_RECORDINGS_PER_OWNER;
			index++
		) {
			const driveId = `quota-drive-${index}`;
			await database.insert(driveSession).values({
				id: driveId,
				carId: CAR_ID,
				startedAt: NOW.toISOString(),
			});
			await authority.create({
				...createCommand(driveId),
				input: { ...createCommand(driveId).input, sizeBytes: 1 },
			});
		}
		const extraDrive = 'quota-drive-extra';
		await database.insert(driveSession).values({
			id: extraDrive,
			carId: CAR_ID,
			startedAt: NOW.toISOString(),
		});
		await expectCode(
			authority.create({
				...createCommand(extraDrive),
				input: { ...createCommand(extraDrive).input, sizeBytes: 1 },
			}),
			'QUOTA_EXCEEDED',
		);
	});

	test('enforces the atomic owner quota when concurrent creates pass the initial read', async () => {
		const { authority, database, r2 } = await authorityFixture();
		for (const suffix of ['a', 'b'])
			await database.insert(driveSession).values({
				id: `concurrent-drive-${suffix}`,
				carId: CAR_ID,
				startedAt: NOW.toISOString(),
			});
		const createMultipart = r2.bucket.createMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'createMultipartUpload').mockImplementationOnce(
			async (key, options) => {
				const multipart = await createMultipart(key, options);
				await database.insert(raceVideo).values(
					['a', 'b'].map((suffix) => ({
						id: `concurrent-recording-${suffix}`,
						ownerId: OWNER_ID,
						carId: CAR_ID,
						driveSessionId: `concurrent-drive-${suffix}`,
						requestId: `concurrent-request-${suffix}`,
						objectKey: `race-recordings/concurrent/${suffix}`,
						multipartUploadId: `concurrent-upload-${suffix}`,
						fileName: 'Concurrent.mp4',
						contentType: 'video/mp4',
						declaredSize: 1,
						actualSize: null,
						partSize: RACE_RECORDING_PART_SIZE,
						status: 'uploading' as const,
						createdAt: NOW.toISOString(),
						updatedAt: NOW.toISOString(),
						expiresAt: '2026-08-23T20:00:00.000Z',
						completedAt: null,
					})),
				);
				return multipart;
			},
		);
		await expectCode(authority.create(createCommand()), 'QUOTA_EXCEEDED');
		expect(r2.multipartUploads.size).toBe(0);
	});

	test('enforces retained-storage quota and upload-creation rate limits', async () => {
		const { authority, database } = await authorityFixture();
		await database.insert(authRateLimit).values({
			key: `race-video-upload:${OWNER_ID}`,
			windowStartedAt: NOW.getTime(),
			count: MAX_RACE_RECORDING_CREATIONS_PER_HOUR,
		});
		await expectCode(authority.create(createCommand()), 'RATE_LIMITED');

		await database.delete(authRateLimit);
		for (let index = 1; index <= 10; index++) {
			const driveId = `retained-drive-${index}`;
			await database.insert(driveSession).values({
				id: driveId,
				carId: CAR_ID,
				startedAt: NOW.toISOString(),
			});
			await database.insert(raceVideo).values({
				id: `retained-recording-${index}`,
				ownerId: OWNER_ID,
				carId: CAR_ID,
				driveSessionId: driveId,
				requestId: `retained-request-${index}`,
				objectKey: `race-recordings/retained/${index}`,
				multipartUploadId: `retained-upload-${index}`,
				fileName: 'Retained.mp4',
				contentType: 'video/mp4',
				declaredSize: 10 * 1024 * 1024 * 1024,
				actualSize: 10 * 1024 * 1024 * 1024,
				partSize: RACE_RECORDING_PART_SIZE,
				status: 'validating',
				createdAt: NOW.toISOString(),
				updatedAt: NOW.toISOString(),
				expiresAt: '2026-08-23T20:00:00.000Z',
				completedAt: NOW.toISOString(),
			});
		}
		await expectCode(authority.create(createCommand()), 'QUOTA_EXCEEDED');
	});

	test('resets an expired upload-creation rate-limit window', async () => {
		const { authority, database } = await authorityFixture();
		await database.insert(authRateLimit).values({
			key: `race-video-upload:${OWNER_ID}`,
			windowStartedAt: NOW.getTime() - 2 * 60 * 60 * 1000,
			count: MAX_RACE_RECORDING_CREATIONS_PER_HOUR,
		});
		await expect(authority.create(createCommand())).resolves.toMatchObject({
			created: true,
		});
		expect(
			await database
				.select()
				.from(authRateLimit)
				.where(eq(authRateLimit.key, `race-video-upload:${OWNER_ID}`))
				.get(),
		).toMatchObject({ windowStartedAt: NOW.getTime(), count: 1 });
	});

	test('increments upload-creation rate limits atomically', async () => {
		const { authority, database } = await authorityFixture();
		await database.insert(authRateLimit).values({
			key: `race-video-upload:${OWNER_ID}`,
			windowStartedAt: NOW.getTime(),
			count: MAX_RACE_RECORDING_CREATIONS_PER_HOUR - 1,
		});
		for (const driveId of ['rate-drive-1', 'rate-drive-2'])
			await database.insert(driveSession).values({
				id: driveId,
				carId: CAR_ID,
				startedAt: NOW.toISOString(),
			});
		const outcomes = await Promise.allSettled([
			authority.create(createCommand('rate-drive-1')),
			authority.create(createCommand('rate-drive-2')),
		]);
		expect(
			outcomes.filter(({ status }) => status === 'fulfilled'),
		).toHaveLength(1);
		expect(
			outcomes.filter(({ status }) => status === 'rejected'),
		).toMatchObject([{ reason: { code: 'RATE_LIMITED' } }]);
	});

	test('cleans expired uploads monotonically and validates cleanup bounds', async () => {
		const { authority, database, setNow, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		setNow(new Date('2026-08-24T20:00:00.000Z'));
		await expect(authority.cleanupExpired(undefined, 0)).rejects.toThrow(
			'between 1 and 100',
		);
		expect(await authority.cleanupExpired(undefined, 1)).toBe(1);
		expect(await authority.cleanupExpired(undefined, 1)).toBe(0);
		expect(r2.multipartUploads.size).toBe(0);
		expect(
			await database
				.select()
				.from(raceVideo)
				.where(eq(raceVideo.id, recording.id)),
		).toEqual([]);
	});

	test('recovers stale part, completion, and deletion work within one bound', async () => {
		const { authority, database, setNow } = await authorityFixture();
		await expect(authority.recoverStale(0)).rejects.toThrow(
			'between 1 and 100',
		);
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await database.insert(raceVideoUploadPart).values({
			raceVideoId: recording.id,
			partNumber: 1,
			transferRequestId: null,
			status: 'uploading',
			claimId: 'stale-claim',
			claimTransferRequestId: 'stale-transfer',
			etag: null,
			byteCount: 1,
			claimedAt: NOW.toISOString(),
			uploadedAt: null,
		});
		setNow(new Date(NOW.getTime() + 16 * 60 * 1000));
		expect(await authority.recoverStale(1)).toBe(1);
		expect(
			await database
				.select()
				.from(raceVideoUploadPart)
				.where(eq(raceVideoUploadPart.raceVideoId, recording.id))
				.get(),
		).toMatchObject({ status: 'recoverable', claimId: null });

		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'recovered-transfer',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		await database
			.update(raceVideo)
			.set({ status: 'completing', updatedAt: NOW.toISOString() })
			.where(eq(raceVideo.id, recording.id));
		expect(await authority.recoverStale(1)).toBe(1);
		expect(await authority.get(OWNER_ID, recording.id)).toMatchObject({
			status: 'validating',
		});
	});

	test('fails closed when an expiration or deletion claim loses its witness', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const raced = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					return query.startsWith('update "race_video" set "status"')
						? withoutReturningRows(statement)
						: statement;
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => new Date('2026-08-24T20:00:00.000Z') },
		);
		await expectCode(raced.remove(identity(recording.id)), 'CONFLICT');
		await expectCode(
			raced.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'expired-race',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		expect(await raced.cleanupExpired(undefined, 1)).toBe(0);
	});

	test('fails closed when R2 creation, transfer, completion, or cleanup fails', async () => {
		const { authority, r2 } = await authorityFixture();
		vi.spyOn(r2.bucket, 'createMultipartUpload').mockRejectedValueOnce(
			new Error('down'),
		);
		await expectCode(authority.create(createCommand()), 'STORAGE_UNAVAILABLE');

		const { recording } = await authority.create(createCommand());
		const resumed = r2.bucket.resumeMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => ({
				...resumed(key, uploadId),
				uploadPart: async () => {
					throw new Error('down');
				},
			}),
		);
		await expectCode(
			authority.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'failed',
				...streamingPart(new Uint8Array(RACE_RECORDING_PART_SIZE).buffer),
			}),
			'STORAGE_UNAVAILABLE',
		);

		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'one',
			...streamingPart(new Uint8Array(RACE_RECORDING_PART_SIZE).buffer),
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 2,
			transferRequestId: 'two',
			...streamingPart(Uint8Array.of(1, 2, 3).buffer),
		});
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(() => ({
			key: 'missing',
			uploadId: 'missing',
			uploadPart: async () => ({ partNumber: 1, etag: 'none' }),
			abort: async () => undefined,
			complete: async () => {
				throw new Error('down');
			},
		}));
		await expectCode(
			authority.complete(identity(recording.id)),
			'STORAGE_UNAVAILABLE',
		);

		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(() => ({
			key: 'missing',
			uploadId: 'missing',
			uploadPart: async () => ({ partNumber: 1, etag: 'none' }),
			abort: async () => {
				throw new Error('down');
			},
			complete: async () => {
				throw new Error('down');
			},
		}));
		await expectCode(
			authority.remove(identity(recording.id)),
			'STORAGE_UNAVAILABLE',
		);
		vi.spyOn(r2.bucket, 'delete').mockRejectedValueOnce(
			new Error('object deletion unavailable'),
		);
		await expectCode(
			authority.remove(identity(recording.id)),
			'STORAGE_UNAVAILABLE',
		);
		expect(await authority.recoverStale(1)).toBe(1);
	});

	test('retries D1 cleanup after an already-aborted multipart upload', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const base = sqlite.database;
		const failingDelete = new RaceRecordingAuthority(
			{
				prepare: base.prepare.bind(base),
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: async () => {
					throw new Error('D1 cleanup failed');
				},
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expect(failingDelete.remove(identity(recording.id))).rejects.toThrow(
			'D1 cleanup failed',
		);
		expect(r2.multipartUploads.size).toBe(0);
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockImplementationOnce(
			(key, uploadId) => ({
				key,
				uploadId,
				uploadPart: async () => ({ partNumber: 1, etag: 'unused' }),
				complete: async () => {
					throw new Error('unused');
				},
				abort: () => Promise.reject('NoSuchUpload'),
			}),
		);
		expect(await authority.recoverStale(1)).toBe(1);
		expect(await database.select().from(raceVideo)).toEqual([]);
	});

	test('treats R2 automatic multipart expiry code 10024 as deleted', async () => {
		const { authority, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		vi.spyOn(r2.bucket, 'resumeMultipartUpload').mockReturnValueOnce({
			key: 'expired',
			uploadId: 'expired',
			uploadPart: async () => ({ partNumber: 1, etag: 'unused' }),
			complete: async () => {
				throw new Error('unused');
			},
			abort: async () => {
				throw new Error(
					'The specified multipart upload does not exist (10024)',
				);
			},
		});
		await expect(
			authority.remove(identity(recording.id)),
		).resolves.toBeUndefined();
	});

	test('permanently deletes a completed private recording', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const { recording } = await authority.create({
			...createCommand(),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		await authority.uploadPart({
			...identity(recording.id),
			partNumber: 1,
			transferRequestId: 'complete-one-byte',
			...streamingPart(Uint8Array.of(1).buffer),
		});
		await authority.complete(identity(recording.id));
		const deleteObject = vi.spyOn(r2.bucket, 'delete');
		await expect(
			authority.remove(identity(recording.id)),
		).resolves.toBeUndefined();
		expect(await database.select().from(raceVideo)).toEqual([]);
		expect(deleteObject).toHaveBeenCalledOnce();
	});

	test('reconciles a concurrent create and rejects an unowned insertion conflict', async () => {
		const { authority, database, r2 } = await authorityFixture();
		const createMultipart = r2.bucket.createMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'createMultipartUpload').mockImplementationOnce(
			async (key, options) => {
				const current = await createMultipart(key, options);
				await database.insert(raceVideo).values({
					id: 'raced-recording',
					ownerId: OWNER_ID,
					carId: CAR_ID,
					driveSessionId: DRIVE_ID,
					requestId: createCommand().input.requestId,
					objectKey: 'race-recordings/raced-object',
					multipartUploadId: 'raced-upload',
					fileName: createCommand().input.fileName,
					contentType: createCommand().input.contentType,
					declaredSize: createCommand().input.sizeBytes,
					partSize: RACE_RECORDING_PART_SIZE,
					status: 'uploading' as const,
					createdAt: NOW.toISOString(),
					updatedAt: NOW.toISOString(),
					expiresAt: '2026-08-23T20:00:00.000Z',
					completedAt: null,
				});
				return current;
			},
		);
		const result = await authority.create(createCommand());
		expect(result).toMatchObject({
			created: false,
			recording: { id: 'raced-recording' },
		});
		expect(r2.multipartUploads.size).toBe(0);
	});

	test('fails closed when a conflicting multipart upload cannot be discarded', async () => {
		const { database, r2 } = await authorityFixture();
		await database.insert(driveSession).values({
			id: 'other-drive',
			carId: CAR_ID,
			startedAt: NOW.toISOString(),
		});
		await database.insert(raceVideo).values({
			id: 'opaque-1',
			ownerId: OWNER_ID,
			carId: CAR_ID,
			driveSessionId: 'other-drive',
			requestId: 'existing-request',
			objectKey: 'race-recordings/existing-object',
			multipartUploadId: 'existing-upload',
			fileName: 'Other.mov',
			contentType: 'video/quicktime',
			declaredSize: 1,
			partSize: RACE_RECORDING_PART_SIZE,
			status: 'uploading',
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			expiresAt: '2026-08-23T20:00:00.000Z',
			completedAt: null,
		});
		const createMultipart = r2.bucket.createMultipartUpload.bind(r2.bucket);
		vi.spyOn(r2.bucket, 'createMultipartUpload').mockImplementationOnce(
			async (key, options) => {
				const multipart = await createMultipart(key, options);
				return {
					...multipart,
					abort: async () => {
						throw new Error('abort failed');
					},
				};
			},
		);
		let id = 0;
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const authority = new RaceRecordingAuthority(sqlite.database, r2.bucket, {
			clock: () => NOW,
			id: () => `opaque-${++id}`,
		});
		await expectCode(authority.create(createCommand()), 'STORAGE_UNAVAILABLE');
	});

	test('discards a failed create and reports D1 progress conflicts', async () => {
		const { database, r2 } = await authorityFixture();
		await database.insert(driveSession).values({
			id: 'other-drive',
			carId: CAR_ID,
			startedAt: NOW.toISOString(),
		});
		await database.insert(raceVideo).values({
			id: 'opaque-1',
			ownerId: OWNER_ID,
			carId: CAR_ID,
			driveSessionId: 'other-drive',
			requestId: 'existing-request',
			objectKey: 'race-recordings/existing-object',
			multipartUploadId: 'existing-upload',
			fileName: 'Other.mov',
			contentType: 'video/quicktime',
			declaredSize: 1,
			partSize: RACE_RECORDING_PART_SIZE,
			status: 'uploading',
			createdAt: NOW.toISOString(),
			updatedAt: NOW.toISOString(),
			expiresAt: '2026-08-23T20:00:00.000Z',
			completedAt: null,
		});
		let id = 0;
		if (!sqlite) throw new Error('SQLite fixture is unavailable');
		const authority = new RaceRecordingAuthority(sqlite.database, r2.bucket, {
			clock: () => NOW,
			id: () => `opaque-${++id}`,
		});
		await expectCode(authority.create(createCommand()), 'CONFLICT');
		expect(r2.multipartUploads.size).toBe(0);

		const working = new RaceRecordingAuthority(sqlite.database, r2.bucket, {
			clock: () => NOW,
			id: () => `working-${++id}`,
		});
		await database.insert(driveSession).values({
			id: 'quota-drive-new',
			carId: CAR_ID,
			startedAt: NOW.toISOString(),
		});
		const { recording } = await working.create({
			...createCommand('quota-drive-new'),
			input: { ...createCommand().input, sizeBytes: 1 },
		});
		const base = sqlite.database;
		const failingProgress = {
			prepare: (query: string) => {
				if (
					query.includes(
						'update "race_video_upload_part" set "transfer_request_id"',
					)
				)
					throw new Error('D1 progress failed');
				return base.prepare(query);
			},
			exec: base.exec.bind(base),
			withSession: base.withSession.bind(base),
			dump: base.dump.bind(base),
			batch: base.batch.bind(base),
		} satisfies D1Database;
		const failing = new RaceRecordingAuthority(failingProgress, r2.bucket, {
			clock: () => NOW,
		});
		await expectCode(
			failing.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'd1-failure',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		await database
			.update(raceVideoUploadPart)
			.set({
				status: 'recoverable',
				claimId: null,
				claimTransferRequestId: null,
				claimedAt: null,
			})
			.where(eq(raceVideoUploadPart.raceVideoId, recording.id));
		const missingTouch = new RaceRecordingAuthority(
			{
				prepare: (query: string) => {
					const statement = base.prepare(query);
					return query.startsWith('update "race_video" set "updated_at"')
						? withoutSelectionRows(statement)
						: statement;
				},
				exec: base.exec.bind(base),
				withSession: base.withSession.bind(base),
				dump: base.dump.bind(base),
				batch: base.batch.bind(base),
			},
			r2.bucket,
			{ clock: () => NOW },
		);
		await expectCode(
			missingTouch.uploadPart({
				...identity(recording.id),
				partNumber: 1,
				transferRequestId: 'd1-touch-failure',
				...streamingPart(Uint8Array.of(1).buffer),
			}),
			'CONFLICT',
		);
		expect(
			await database
				.select()
				.from(raceVideoUploadPart)
				.where(eq(raceVideoUploadPart.raceVideoId, recording.id))
				.get(),
		).toMatchObject({
			status: 'uploaded',
			transferRequestId: 'd1-touch-failure',
		});
	});
});
