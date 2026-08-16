import { and, asc, eq, lte, ne, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	preparedTrackingMedia,
	preparedTrackingObject,
	preparedTrackingRetention,
	trackingAuthoritySchema,
	trackingRun,
	trackingRunInput,
} from './authority-schema';
import { preparedMediaArtifactSchema } from './contracts';
import {
	type AcceptPreparedTrackViewCommand,
	acceptPreparedTrackViewCommandSchema,
	FRAME_MANIFEST_CONTENT_TYPE,
	type MarkPreparedTrackViewDeletedCommand,
	markPreparedTrackViewDeletedCommandSchema,
	type PinTrackingRunInputCommand,
	PREPARED_MEDIA_CONTENT_TYPE,
	type PreparedTrackViewObject,
	pinTrackingRunInputCommandSchema,
} from './track-view-contracts';
import { TrackingAuthorityError } from './tracking-authority';
import { digestTrackingRunInput } from './tracking-run-input';

type TrackingRunRecord = typeof trackingRun.$inferSelect;
export type TrackingRunInputRecord = typeof trackingRunInput.$inferSelect;
type PreparedTrackingObjectRecord = typeof preparedTrackingObject.$inferSelect;
type PreparedTrackingRetentionRecord =
	typeof preparedTrackingRetention.$inferSelect;

export type AcceptedPreparedTrackView = {
	descriptor: ReturnType<typeof preparedMediaArtifactSchema.parse>;
	objects: readonly [
		PreparedTrackingObjectRecord,
		PreparedTrackingObjectRecord,
	];
	retention: PreparedTrackingRetentionRecord;
};

export type PreparedTrackViewContext = {
	run: TrackingRunRecord;
	input: TrackingRunInputRecord;
	accepted: AcceptedPreparedTrackView | null;
};

export type PreparedTrackViewCleanupCandidate = {
	ownerId: string;
	runId: string;
	preparedMediaId: string;
	version: number;
	objects: readonly [
		PreparedTrackingObjectRecord,
		PreparedTrackingObjectRecord,
	];
};

const conflict = (message: string) =>
	new TrackingAuthorityError('CONFLICT', message);
const notFound = (message: string) =>
	new TrackingAuthorityError('NOT_FOUND', message);
const stale = (message: string) =>
	new TrackingAuthorityError('STALE_AUTHORITY', message);

const objectForRole = (
	objects: readonly PreparedTrackViewObject[],
	role: PreparedTrackViewObject['role'],
): PreparedTrackViewObject | undefined =>
	objects.find((object) => object.role === role);

const assertObjectContract = (
	command: AcceptPreparedTrackViewCommand,
): void => {
	const media = objectForRole(command.objects, 'prepared-media');
	const manifest = objectForRole(command.objects, 'frame-manifest');
	if (
		!media ||
		!manifest ||
		media.objectKey === manifest.objectKey ||
		media.byteCount !== command.descriptor.byteCount ||
		media.checksumSha256 !== command.descriptor.checksumSha256 ||
		media.contentType !== PREPARED_MEDIA_CONTENT_TYPE ||
		media.contentEncoding !== null ||
		manifest.byteCount !== command.descriptor.frameManifestByteCount ||
		manifest.checksumSha256 !==
			command.descriptor.frameManifestChecksumSha256 ||
		manifest.contentType !== FRAME_MANIFEST_CONTENT_TYPE ||
		manifest.contentEncoding !== 'gzip'
	)
		throw conflict('Prepared Track-view objects do not match the descriptor');
};

const inputMatches = (
	left: TrackingRunInputRecord,
	right: PinTrackingRunInputCommand,
	digest: string,
): boolean => {
	const input = right.input;
	return (
		left.runId === input.runId &&
		left.ownerId === right.ownerId &&
		left.raceVideoId === input.raceVideoId &&
		left.sourceObjectKey === input.sourceObjectKey &&
		left.sourceByteCount === input.sourceByteCount &&
		left.sourceChecksum === input.sourceChecksumSha256 &&
		left.windowStartTimestampMs === input.window.startTimestampMs &&
		left.windowEndTimestampMs === input.window.endTimestampMs &&
		left.approvedTrackMapVersionId === input.approvedTrackMapVersionId &&
		left.sourceLayoutVersion === input.sourceLayout.version &&
		left.sourceLayoutDigest === input.sourceLayout.digest &&
		left.sourceWidth === input.sourceLayout.width &&
		left.sourceHeight === input.sourceLayout.height &&
		left.inputDigest === digest &&
		left.createdAt === right.createdAt
	);
};

export class PreparedTrackViewAuthority {
	private readonly database;

	constructor(binding: D1Database) {
		this.database = drizzle(binding, { schema: trackingAuthoritySchema });
	}

	async pinRunInput(
		commandValue: PinTrackingRunInputCommand,
	): Promise<TrackingRunInputRecord> {
		const command = pinTrackingRunInputCommandSchema.parse(commandValue);
		const digest = await digestTrackingRunInput(command.input);
		const run = await this.requireRun(command.ownerId, command.input.runId);
		if (run.status !== 'active' || run.inputDigest !== digest)
			throw stale('Tracking run no longer authorizes this immutable input');

		await this.database
			.insert(trackingRunInput)
			.select(
				this.database
					.select({
						runId: sql<string>`${command.input.runId}`,
						ownerId: sql<string>`${command.ownerId}`,
						raceVideoId: sql<string>`${command.input.raceVideoId}`,
						sourceObjectKey: sql<string>`${command.input.sourceObjectKey}`,
						sourceByteCount: sql<number>`${command.input.sourceByteCount}`,
						sourceChecksum: sql<string>`${command.input.sourceChecksumSha256}`,
						windowStartTimestampMs: sql<number>`${command.input.window.startTimestampMs}`,
						windowEndTimestampMs: sql<number>`${command.input.window.endTimestampMs}`,
						approvedTrackMapVersionId: sql<string>`${command.input.approvedTrackMapVersionId}`,
						sourceLayoutVersion: sql<string>`${command.input.sourceLayout.version}`,
						sourceLayoutDigest: sql<string>`${command.input.sourceLayout.digest}`,
						sourceWidth: sql<number>`${command.input.sourceLayout.width}`,
						sourceHeight: sql<number>`${command.input.sourceLayout.height}`,
						inputDigest: sql<string>`${digest}`,
						createdAt: sql<string>`${command.createdAt}`,
					})
					.from(trackingRun)
					.where(
						and(
							eq(trackingRun.id, command.input.runId),
							eq(trackingRun.ownerId, command.ownerId),
							eq(trackingRun.status, 'active'),
							eq(trackingRun.inputDigest, digest),
						),
					),
			)
			.onConflictDoNothing();
		const stored = await this.database
			.select()
			.from(trackingRunInput)
			.where(
				and(
					eq(trackingRunInput.runId, command.input.runId),
					eq(trackingRunInput.ownerId, command.ownerId),
				),
			)
			.get();
		/* c8 ignore next 4 -- an insert-or-existing D1 write always yields one matching identity unless the run was concurrently fenced or D1 fails. */
		if (!stored) {
			await this.requireActiveRun(command.ownerId, command.input.runId);
			throw conflict('Tracking input was not pinned');
		}
		if (!inputMatches(stored, command, digest))
			throw conflict(
				'Tracking run input was replayed with different immutable input',
			);
		return stored;
	}

	async preparationContext(
		ownerId: string,
		runId: string,
	): Promise<PreparedTrackViewContext> {
		const run = await this.requireActiveRun(ownerId, runId);
		const input = await this.database
			.select()
			.from(trackingRunInput)
			.where(
				and(
					eq(trackingRunInput.runId, runId),
					eq(trackingRunInput.ownerId, ownerId),
				),
			)
			.get();
		if (!input) throw notFound('Tracking run input was not found');
		return {
			run,
			input,
			accepted: await this.accepted(runId),
		};
	}

	async acceptPreparedTrackView(
		commandValue: AcceptPreparedTrackViewCommand,
	): Promise<AcceptedPreparedTrackView> {
		const command = acceptPreparedTrackViewCommandSchema.parse(commandValue);
		assertObjectContract(command);
		const context = await this.preparationContext(
			command.ownerId,
			command.runId,
		);
		if (
			context.run.version !== command.expectedRunVersion ||
			context.run.inputDigest !== command.expectedInputDigest ||
			context.input.inputDigest !== command.expectedInputDigest ||
			command.descriptor.preparationInputDigest !==
				command.expectedInputDigest ||
			command.descriptor.caseId !== command.runId ||
			command.descriptor.sourceByteCount !== context.input.sourceByteCount ||
			command.descriptor.sourceChecksumSha256 !==
				context.input.sourceChecksum ||
			command.descriptor.window.startTimestampMs !==
				context.input.windowStartTimestampMs ||
			command.descriptor.window.endTimestampMs !==
				context.input.windowEndTimestampMs
		)
			throw stale('Prepared Track view does not match current run authority');

		const descriptorJson = JSON.stringify(command.descriptor);
		const objectValues = command.objects.map((object) => ({
			preparedMediaId: command.descriptor.preparedMediaId,
			runId: command.runId,
			...object,
			createdAt: command.createdAt,
		}));
		try {
			await this.database.batch([
				this.database
					.insert(preparedTrackingMedia)
					.select(
						this.database
							.select({
								id: sql<string>`${command.descriptor.preparedMediaId}`,
								runId: sql<string>`${command.runId}`,
								descriptorJson: sql<string>`${descriptorJson}`,
								preparationInputDigest: sql<string>`${command.descriptor.preparationInputDigest}`,
								preparedChecksum: sql<string>`${command.descriptor.checksumSha256}`,
								frameManifestChecksum: sql<string>`${command.descriptor.frameManifestChecksumSha256}`,
								sourceChecksum: sql<string>`${command.descriptor.sourceChecksumSha256}`,
								windowStartTimestampMs: sql<number>`${command.descriptor.window.startTimestampMs}`,
								windowEndTimestampMs: sql<number>`${command.descriptor.window.endTimestampMs}`,
								createdAt: sql<string>`${command.createdAt}`,
							})
							.from(trackingRun)
							.innerJoin(
								trackingRunInput,
								eq(trackingRunInput.runId, trackingRun.id),
							)
							.where(
								and(
									eq(trackingRun.id, command.runId),
									eq(trackingRun.ownerId, command.ownerId),
									eq(trackingRun.status, 'active'),
									eq(trackingRun.version, command.expectedRunVersion),
									eq(trackingRun.inputDigest, command.expectedInputDigest),
									eq(trackingRunInput.inputDigest, command.expectedInputDigest),
								),
							),
					)
					.onConflictDoNothing(),
				...objectValues.map((object) =>
					this.database
						.insert(preparedTrackingObject)
						.values(object)
						.onConflictDoNothing(),
				),
				this.database
					.insert(preparedTrackingRetention)
					.values({
						runId: command.runId,
						preparedMediaId: command.descriptor.preparedMediaId,
						deleteAfter: command.deleteAfter,
						state: 'active',
						version: 1,
						deletedAt: null,
						createdAt: command.createdAt,
						updatedAt: command.createdAt,
					})
					.onConflictDoNothing(),
			]);
		} catch {
			await this.requireActiveRun(command.ownerId, command.runId);
			throw conflict('Prepared Track view conflicted with immutable authority');
		}
		const accepted = await this.accepted(command.runId);
		/* c8 ignore next -- the atomic descriptor/object/retention batch always yields a complete accepted record unless D1 fails. */
		if (!accepted) throw conflict('Prepared Track view was not persisted');
		if (
			JSON.stringify(accepted.descriptor) !== descriptorJson ||
			accepted.retention.deleteAfter !== command.deleteAfter ||
			accepted.retention.createdAt !== command.createdAt ||
			accepted.objects.some((stored) => {
				const candidate = objectForRole(command.objects, stored.role);
				return (
					!candidate ||
					stored.objectKey !== candidate.objectKey ||
					stored.byteCount !== candidate.byteCount ||
					stored.checksumSha256 !== candidate.checksumSha256 ||
					stored.contentType !== candidate.contentType ||
					stored.contentEncoding !== candidate.contentEncoding ||
					stored.createdAt !== command.createdAt
				);
			})
		)
			throw conflict(
				'Prepared Track-view identity was replayed with different immutable input',
			);
		return accepted;
	}

	async cleanupCandidates(
		now: string,
		terminalBefore: string,
		limit = 50,
	): Promise<readonly PreparedTrackViewCleanupCandidate[]> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError('Cleanup limit must be between 1 and 100');
		const rows = await this.database
			.select({
				ownerId: trackingRun.ownerId,
				runId: preparedTrackingRetention.runId,
				preparedMediaId: preparedTrackingRetention.preparedMediaId,
				version: preparedTrackingRetention.version,
			})
			.from(preparedTrackingRetention)
			.innerJoin(
				trackingRun,
				eq(trackingRun.id, preparedTrackingRetention.runId),
			)
			.where(
				and(
					eq(preparedTrackingRetention.state, 'active'),
					lte(preparedTrackingRetention.deleteAfter, now),
					ne(trackingRun.status, 'active'),
					lte(trackingRun.completedAt, terminalBefore),
				),
			)
			.orderBy(asc(preparedTrackingRetention.deleteAfter))
			.limit(limit);
		return Promise.all(
			rows.map(async (row) => ({
				...row,
				objects: await this.objects(row.preparedMediaId),
			})),
		);
	}

	async isAcceptedCandidate(
		ownerId: string,
		runId: string,
		preparedMediaId: string,
	): Promise<boolean> {
		await this.requireRun(ownerId, runId);
		const accepted = await this.accepted(runId);
		return accepted?.descriptor.preparedMediaId === preparedMediaId;
	}

	async markDeleted(
		commandValue: MarkPreparedTrackViewDeletedCommand,
	): Promise<PreparedTrackingRetentionRecord> {
		const command =
			markPreparedTrackViewDeletedCommandSchema.parse(commandValue);
		const run = await this.requireRun(command.ownerId, command.runId);
		if (run.status === 'active')
			throw stale('Active Tracking-run media cannot be deleted');
		const updated = await this.database
			.update(preparedTrackingRetention)
			.set({
				state: 'deleted',
				version: command.expectedVersion + 1,
				deletedAt: command.deletedAt,
				updatedAt: command.deletedAt,
			})
			.where(
				and(
					eq(preparedTrackingRetention.runId, command.runId),
					eq(
						preparedTrackingRetention.preparedMediaId,
						command.preparedMediaId,
					),
					eq(preparedTrackingRetention.state, 'active'),
					eq(preparedTrackingRetention.version, command.expectedVersion),
				),
			)
			.returning()
			.get();
		if (updated) return updated;
		const stored = await this.database
			.select()
			.from(preparedTrackingRetention)
			.where(eq(preparedTrackingRetention.runId, command.runId))
			.get();
		if (
			stored?.state === 'deleted' &&
			stored.preparedMediaId === command.preparedMediaId &&
			stored.version === command.expectedVersion + 1 &&
			stored.deletedAt === command.deletedAt
		)
			return stored;
		throw stale('Prepared Track-view cleanup authority changed');
	}

	private async accepted(
		runId: string,
	): Promise<AcceptedPreparedTrackView | null> {
		const media = await this.database
			.select()
			.from(preparedTrackingMedia)
			.where(eq(preparedTrackingMedia.runId, runId))
			.get();
		if (!media) return null;
		const [objects, retention] = await Promise.all([
			this.objects(media.id),
			this.database
				.select()
				.from(preparedTrackingRetention)
				.where(eq(preparedTrackingRetention.runId, runId))
				.get(),
		]);
		/* c8 ignore next 2 -- typed acceptance commits retention in the same D1 batch as the descriptor and object bindings. */
		if (!retention)
			throw conflict('Prepared Track-view authority is incomplete');
		return {
			descriptor: preparedMediaArtifactSchema.parse(
				JSON.parse(media.descriptorJson),
			),
			objects,
			retention,
		};
	}

	private async objects(
		preparedMediaId: string,
	): Promise<
		readonly [PreparedTrackingObjectRecord, PreparedTrackingObjectRecord]
	> {
		const objects = await this.database
			.select()
			.from(preparedTrackingObject)
			.where(eq(preparedTrackingObject.preparedMediaId, preparedMediaId))
			.orderBy(asc(preparedTrackingObject.role));
		/* c8 ignore next 6 -- only legacy or externally corrupted D1 rows can be incomplete; every typed writer commits both immutable roles atomically. */
		if (
			objects.length !== 2 ||
			objects[0]?.role !== 'frame-manifest' ||
			objects[1]?.role !== 'prepared-media'
		)
			throw conflict('Prepared Track-view object authority is incomplete');
		return [objects[0], objects[1]];
	}

	private async requireRun(
		ownerId: string,
		runId: string,
	): Promise<TrackingRunRecord> {
		const run = await this.database
			.select()
			.from(trackingRun)
			.where(and(eq(trackingRun.id, runId), eq(trackingRun.ownerId, ownerId)))
			.get();
		if (!run) throw notFound('Tracking run was not found for this owner');
		return run;
	}

	private async requireActiveRun(
		ownerId: string,
		runId: string,
	): Promise<TrackingRunRecord> {
		const run = await this.requireRun(ownerId, runId);
		if (run.status !== 'active')
			throw stale('Tracking run is no longer active');
		return run;
	}
}
