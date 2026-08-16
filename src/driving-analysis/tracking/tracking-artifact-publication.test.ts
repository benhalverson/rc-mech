import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, test } from 'vitest';
import {
	ATTEMPT_ID,
	inferenceProfileFixture,
	LEASE_ID,
	PREPARED_ID,
	PROFILE_DIGEST,
	RUN_ID,
	SEGMENT_ID,
	submissionFixture,
	TRANSFER_ID,
} from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import {
	preparedDescriptorFixture,
	preparedObjectsFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import type {
	GpuLeaseHoldInput,
	GpuLeaseHoldReleaseInput,
	GpuLeaseMutationResult,
	GpuLeaseReleaseInput,
} from '../gpu-lease-coordinator';
import type { OutputArtifact, SubjectProvenance } from './contracts';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import {
	R2TrackingArtifactStore,
	type TrackingArtifactStore,
	TrackingArtifactStoreError,
} from './r2-tracking-artifact-store';
import {
	acceptedEvidenceObjectKey,
	stagingArtifactObjectKey,
	subjectProvenanceForProfile,
	TRACKING_ARTIFACT_GARBAGE_RETENTION_MS,
	TRACKING_ARTIFACT_MAX_CONTRACT_BYTES,
	TrackingArtifactPublication,
	TrackingArtifactPublicationError,
	trackingArtifactPublication,
	trackingInputDigestFor,
} from './tracking-artifact-publication';
import { TrackingAuthority } from './tracking-authority';

const OWNER_ID = 'owner-1';
const ANALYSIS_ID = 'analysis-1';
const WORKFLOW_ID = 'workflow-1';
const INPUT_DIGEST =
	'b9fcffe729ec029ce020dc5e1583d9573579d6576ffd8bfc036e05ca77b8f133';
const START = new Date('2026-08-16T20:00:00.000Z');

const migrationDirectory = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../migrations',
);
const migrations = [
	'0019_tracking_authority.sql',
	'0020_immutable_track_view.sql',
	'0022_tracking_artifact_publication.sql',
]
	.map((name) => readFileSync(resolve(migrationDirectory, name), 'utf8'))
	.join('\n');

let sqlite: SqliteD1Fixture | undefined;

afterEach(() => {
	sqlite?.close();
	sqlite = undefined;
});

class LeaseCoordinatorFixture {
	beginResult: GpuLeaseMutationResult = {
		status: 'ok',
		holdId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
		expiresAt: START.getTime() + 30_000,
	};
	releaseResult: GpuLeaseMutationResult = { status: 'ok' };
	releaseError: Error | undefined;
	holdReleaseError: Error | undefined;
	onBegin: (() => Promise<void>) | undefined;
	readonly beginCalls: GpuLeaseHoldInput[] = [];
	readonly holdReleaseCalls: GpuLeaseHoldReleaseInput[] = [];
	readonly releaseCalls: GpuLeaseReleaseInput[] = [];

	async beginCommitHold(
		input: GpuLeaseHoldInput,
	): Promise<GpuLeaseMutationResult> {
		this.beginCalls.push(input);
		await this.onBegin?.();
		return this.beginResult;
	}

	async releaseCommitHold(
		input: GpuLeaseHoldReleaseInput,
	): Promise<GpuLeaseMutationResult> {
		this.holdReleaseCalls.push(input);
		if (this.holdReleaseError) throw this.holdReleaseError;
		return { status: 'ok' };
	}

	async release(input: GpuLeaseReleaseInput): Promise<GpuLeaseMutationResult> {
		this.releaseCalls.push(input);
		if (this.releaseError) throw this.releaseError;
		return this.releaseResult;
	}
}

type PublicationFixture = Awaited<ReturnType<typeof publicationFixture>>;

const publicationFixture = async () => {
	sqlite = createSqliteD1();
	sqlite.exec(migrations);
	const authority = new TrackingAuthority(sqlite.database);
	const preparedAuthority = new PreparedTrackViewAuthority(sqlite.database);
	await authority.createRun({
		runId: RUN_ID,
		analysisId: ANALYSIS_ID,
		ownerId: OWNER_ID,
		sequence: 1,
		workflowId: WORKFLOW_ID,
		profile: inferenceProfileFixture(),
		inputDigest: INPUT_DIGEST,
		createdAt: START.toISOString(),
	});
	await preparedAuthority.pinRunInput({
		ownerId: OWNER_ID,
		input: trackingRunInputFixture(),
		createdAt: START.toISOString(),
	});
	await preparedAuthority.acceptPreparedTrackView({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		expectedRunVersion: 1,
		expectedInputDigest: INPUT_DIGEST,
		descriptor: preparedDescriptorFixture(INPUT_DIGEST, PREPARED_ID),
		objects: preparedObjectsFixture(PREPARED_ID),
		deleteAfter: '2026-08-18T20:00:00.000Z',
		createdAt: START.toISOString(),
	});
	const segment = await authority.createSegment({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		order: 0,
		seed: {
			kind: 'initial',
			sourceId: null,
			value: submissionFixture().trackingRequest.subjectSeed,
		},
		preparedMediaId: PREPARED_ID,
		specificationVersion: 'tracking-segment-spec.v1',
		availabilityDeadlineAt: 2_000_000_000,
		createdAt: START.toISOString(),
	});
	await authority.activateAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedCurrentAttemptId: null,
		createdAt: START.toISOString(),
	});
	await authority.transitionAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedState: 'active',
		nextState: 'processing',
		progress: 20,
		safeFailureCode: null,
		updatedAt: START.toISOString(),
	});
	await authority.transitionAttempt({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		expectedState: 'processing',
		nextState: 'output-ready',
		progress: 90,
		safeFailureCode: null,
		updatedAt: START.toISOString(),
	});
	await authority.authorizeTransferGrant({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		profileDigest: PROFILE_DIGEST,
		specificationDigest: segment.specificationDigest,
		transferRequestId: TRANSFER_ID,
		role: 'observation-artifact',
		method: 'PUT',
		requestedAt: START.toISOString(),
	});
	const context = await authority.prepareArtifactPublication({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		profileDigest: PROFILE_DIGEST,
		specificationDigest: segment.specificationDigest,
		transferRequestId: TRANSFER_ID,
	});
	const r2 = new MockR2Controller();
	const store = new R2TrackingArtifactStore(r2.bucket);
	const lease = new LeaseCoordinatorFixture();
	let clock = START;
	const publication = new TrackingArtifactPublication(
		authority,
		store,
		lease,
		() => clock,
	);
	return {
		authority,
		context,
		lease,
		publication,
		r2,
		segment,
		store,
		setClock: (value: Date) => {
			clock = value;
		},
	};
};

const artifactFixture = async (
	value: PublicationFixture,
	options: { empty?: boolean; gap?: boolean } = {},
): Promise<{ artifact: OutputArtifact; bytes: Uint8Array }> => {
	const provenance = await subjectProvenanceForProfile(
		inferenceProfileFixture(),
	);
	const openGap = options.gap
		? ({ startTimestampMs: 250, reason: 'ambiguous-identity' } as const)
		: null;
	const envelope = {
		contractVersion: 'subject-observation-segment.v1' as const,
		outcome: 'accepted' as const,
		caseId: value.context.prepared.caseId,
		observations: options.empty ? [] : [observation(100, 1, provenance)],
		openGap,
		provenance,
	};
	const bytes = await gzip(
		new TextEncoder().encode(`${JSON.stringify(envelope)}\n`),
	);
	const artifact: OutputArtifact = {
		contractVersion: 'tracking-artifact.v1',
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fencingToken: 7,
		specificationDigest: value.segment.specificationDigest,
		profileDigest: PROFILE_DIGEST,
		segment: {
			observationSegmentId: SEGMENT_ID,
			caseId: value.context.prepared.caseId,
			byteCount: bytes.byteLength,
			checksumSha256: await digest(bytes),
			contentEncoding: 'gzip',
			mediaType: 'application/vnd.rc-mech.subject-observations+json',
			observationCount: envelope.observations.length,
			completed: openGap === null,
			gap: openGap,
			provenance,
			ffmpegVersion: value.context.prepared.ffmpegVersion,
			sourceChecksumSha256: value.context.prepared.sourceChecksumSha256,
			preparedChecksumSha256: value.context.prepared.checksumSha256,
			preparationConfigurationDigest:
				value.context.prepared.preparationConfigurationDigest,
			trackingInputDigest: await trackingInputDigestFor(
				value.context,
				SEGMENT_ID,
				provenance,
			),
		},
	};
	return { artifact, bytes };
};

const artifactWithBytes = async (
	artifact: OutputArtifact,
	bytes: Uint8Array,
): Promise<OutputArtifact> => ({
	...artifact,
	segment: {
		...artifact.segment,
		byteCount: bytes.byteLength,
		checksumSha256: await digest(bytes),
	},
});

const observation = (
	timestampMs: number,
	frameIndex: number,
	provenance: SubjectProvenance,
) => ({
	timestampMs,
	frameIndex,
	box: { x: 0.1, y: 0.2, width: 0.2, height: 0.2 },
	center: { x: 0.2, y: 0.3 },
	visibility: 'visible' as const,
	identityConfidence: 0.9,
	origin: 'detected' as const,
	provenance,
});

const seedStaging = (value: PublicationFixture, bytes: Uint8Array): void => {
	value.r2.seed(stagingArtifactObjectKey(ATTEMPT_ID, TRANSFER_ID), bytes, {
		contentType: 'application/octet-stream',
	});
};

const publish = (
	value: PublicationFixture,
	artifact: OutputArtifact,
	ownerId = OWNER_ID,
) =>
	value.publication.publish({
		ownerId,
		transferRequestId: TRANSFER_ID,
		artifact,
	});

const wrappingStore = (
	value: PublicationFixture,
	onRead: (
		read: () => ReturnType<TrackingArtifactStore['read']>,
	) => ReturnType<TrackingArtifactStore['read']>,
): TrackingArtifactStore => ({
	read: (key, maximumBytes, expectedEtag) =>
		onRead(() => value.store.read(key, maximumBytes, expectedEtag)),
	putIfAbsent: (key, bytes, checksum) =>
		value.store.putIfAbsent(key, bytes, checksum),
	list: (prefix, cursor) => value.store.list(prefix, cursor),
	delete: (keys) => value.store.delete(keys),
});

describe('TrackingArtifactPublication', () => {
	test('validates, promotes, binds, releases, and replays one immutable artifact', async () => {
		const value = await publicationFixture();
		const { artifact, bytes } = await artifactFixture(value);
		seedStaging(value, bytes);

		const accepted = await publish(value, artifact);
		expect(accepted).toMatchObject({
			id: ATTEMPT_ID,
			runId: RUN_ID,
			segmentId: SEGMENT_ID,
			attemptId: ATTEMPT_ID,
			checksumSha256: artifact.segment.checksumSha256,
			outcome: 'completed',
		});
		expect(value.lease.beginCalls).toHaveLength(1);
		expect(value.lease.releaseCalls).toEqual([
			{ segmentId: SEGMENT_ID, leaseId: LEASE_ID, fence: 7, completed: true },
		]);
		const acceptedKey = acceptedEvidenceObjectKey(artifact);
		expect(
			await value.store.read(acceptedKey, bytes.byteLength),
		).not.toBeNull();

		expect(await publish(value, artifact)).toEqual(accepted);
		expect(value.lease.beginCalls).toHaveLength(1);
		expect(value.lease.releaseCalls).toHaveLength(2);
		expect(
			await value.authority.publicProvenance(OWNER_ID, ANALYSIS_ID, RUN_ID),
		).toMatchObject({
			segments: [{ artifact: { artifactId: ATTEMPT_ID } }],
		});
	});

	test('fails closed when accepted evidence or its replay authority changes', async () => {
		const missing = await publicationFixture();
		const missingArtifact = await artifactFixture(missing);
		seedStaging(missing, missingArtifact.bytes);
		await publish(missing, missingArtifact.artifact);
		await missing.store.delete([
			acceptedEvidenceObjectKey(missingArtifact.artifact),
		]);
		await expect(publish(missing, missingArtifact.artifact)).rejects.toEqual(
			new TrackingArtifactPublicationError('PROMOTION_CONFLICT'),
		);

		sqlite?.close();
		sqlite = undefined;
		const mismatched = await publicationFixture();
		const mismatchedArtifact = await artifactFixture(mismatched);
		seedStaging(mismatched, mismatchedArtifact.bytes);
		await publish(mismatched, mismatchedArtifact.artifact);
		await expect(
			publish(mismatched, {
				...mismatchedArtifact.artifact,
				leaseId: '55555555-5555-4555-8555-555555555555',
			}),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('PROMOTION_CONFLICT'),
		);

		sqlite?.close();
		sqlite = undefined;
		const releaseFailure = await publicationFixture();
		const releaseArtifact = await artifactFixture(releaseFailure);
		seedStaging(releaseFailure, releaseArtifact.bytes);
		await publish(releaseFailure, releaseArtifact.artifact);
		releaseFailure.lease.releaseError = new Error('coordinator unavailable');
		await expect(
			publish(releaseFailure, releaseArtifact.artifact),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('LEASE_RELEASE_FAILED'),
		);
	});

	test('accepts the strict successful gap outcome', async () => {
		const value = await publicationFixture();
		const { artifact, bytes } = await artifactFixture(value, { gap: true });
		seedStaging(value, bytes);
		expect(await publish(value, artifact)).toMatchObject({
			outcome: 'tracking-gap',
			gapJson: JSON.stringify(artifact.segment.gap),
		});
	});

	test('constructs from Worker bindings and preserves Python canonical digests', async () => {
		const value = await publicationFixture();
		if (!sqlite) throw new Error('Expected the D1 fixture to be available');
		let objectName = '';
		expect(
			trackingArtifactPublication({
				DB: sqlite.database,
				ANALYSIS_MEDIA: value.r2.bucket,
				GPU_LEASE_COORDINATOR: {
					getByName: (name) => {
						objectName = name;
						return value.lease;
					},
				},
			}),
		).toBeInstanceOf(TrackingArtifactPublication);
		expect(objectName).toBe('rtx-3090');
		expect(
			await new TrackingArtifactPublication(
				value.authority,
				value.store,
				value.lease,
			).cleanupDue(),
		).toBe(0);

		for (const identityConfidenceThreshold of [-0, 0, 1e-7]) {
			const provenance = await subjectProvenanceForProfile({
				...inferenceProfileFixture(),
				model: {
					...inferenceProfileFixture().model,
					version: 'modèle',
				},
				identityConfidenceThreshold,
			});
			expect(provenance.configurationDigest).toMatch(/^[0-9a-f]{64}$/);
		}
	});

	test('fails before promotion when staging is missing, changed, or unavailable', async () => {
		const missing = await publicationFixture();
		const missingArtifact = await artifactFixture(missing);
		await expect(publish(missing, missingArtifact.artifact)).rejects.toEqual(
			new TrackingArtifactPublicationError('STAGING_UNAVAILABLE'),
		);

		sqlite?.close();
		sqlite = undefined;
		const disappeared = await publicationFixture();
		const disappearedArtifact = await artifactFixture(disappeared);
		seedStaging(disappeared, disappearedArtifact.bytes);
		let disappearedReads = 0;
		const disappearedStore = wrappingStore(disappeared, async (read) => {
			disappearedReads += 1;
			return disappearedReads === 2 ? null : read();
		});
		await expect(
			new TrackingArtifactPublication(
				disappeared.authority,
				disappearedStore,
				disappeared.lease,
				() => START,
			).publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: disappearedArtifact.artifact,
			}),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('STAGING_UNAVAILABLE'),
		);

		sqlite?.close();
		sqlite = undefined;
		const changed = await publicationFixture();
		const changedArtifact = await artifactFixture(changed);
		seedStaging(changed, changedArtifact.bytes);
		let changedReads = 0;
		const changedStore = wrappingStore(changed, async (read) => {
			changedReads += 1;
			const object = await read();
			return changedReads === 2 && object
				? { ...object, version: 'rewritten-version' }
				: object;
		});
		await expect(
			new TrackingArtifactPublication(
				changed.authority,
				changedStore,
				changed.lease,
				() => START,
			).publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: changedArtifact.artifact,
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('INVALID_ARTIFACT'));

		sqlite?.close();
		sqlite = undefined;
		const lostPromotion = await publicationFixture();
		const lostArtifact = await artifactFixture(lostPromotion);
		seedStaging(lostPromotion, lostArtifact.bytes);
		let lostReads = 0;
		const lostStore = wrappingStore(lostPromotion, async (read) => {
			lostReads += 1;
			return lostReads === 3 ? null : read();
		});
		await expect(
			new TrackingArtifactPublication(
				lostPromotion.authority,
				lostStore,
				lostPromotion.lease,
				() => START,
			).publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: lostArtifact.artifact,
			}),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('PROMOTION_CONFLICT'),
		);
	});

	test('maps private store failures without exposing implementation errors', async () => {
		const oversized = await publicationFixture();
		const oversizedArtifact = await artifactFixture(oversized);
		const oversizedStore = wrappingStore(oversized, async () => {
			throw new TrackingArtifactStoreError('OBJECT_TOO_LARGE');
		});
		await expect(
			new TrackingArtifactPublication(
				oversized.authority,
				oversizedStore,
				oversized.lease,
				() => START,
			).publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: oversizedArtifact.artifact,
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('INVALID_ARTIFACT'));

		sqlite?.close();
		sqlite = undefined;
		const unavailable = await publicationFixture();
		const unavailableArtifact = await artifactFixture(unavailable);
		const unavailableStore = wrappingStore(unavailable, async () => {
			throw new Error('R2 unavailable');
		});
		await expect(
			new TrackingArtifactPublication(
				unavailable.authority,
				unavailableStore,
				unavailable.lease,
				() => START,
			).publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: unavailableArtifact.artifact,
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('COMMIT_FAILED'));
	});

	test('rejects invalid compressed contracts and bounded decompression', async () => {
		const cases = [
			new TextEncoder().encode('not-gzip'),
			await gzip(new TextEncoder().encode('not-json')),
			await gzip(new TextEncoder().encode('{}')),
			await gzip(new Uint8Array(TRACKING_ARTIFACT_MAX_CONTRACT_BYTES + 1)),
		];
		for (const bytes of cases) {
			const value = await publicationFixture();
			const base = await artifactFixture(value);
			const artifact = await artifactWithBytes(base.artifact, bytes);
			seedStaging(value, bytes);
			await expect(publish(value, artifact)).rejects.toEqual(
				new TrackingArtifactPublicationError('INVALID_ARTIFACT'),
			);
			sqlite?.close();
			sqlite = undefined;
		}

		const empty = await publicationFixture();
		const emptyArtifact = await artifactFixture(empty, { empty: true });
		seedStaging(empty, emptyArtifact.bytes);
		expect(await publish(empty, emptyArtifact.artifact)).toMatchObject({
			firstTimestampMs: null,
			lastTimestampMs: null,
		});
	});

	test('rejects malformed, cross-owner, profile-stale, and cancelled output', async () => {
		const malformed = await publicationFixture();
		const malformedArtifact = await artifactFixture(malformed);
		seedStaging(malformed, malformedArtifact.bytes);
		await expect(
			publish(malformed, {
				...malformedArtifact.artifact,
				segment: {
					...malformedArtifact.artifact.segment,
					completed: false,
				},
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('INVALID_ARTIFACT'));

		sqlite?.close();
		sqlite = undefined;
		const descriptorMismatch = await publicationFixture();
		const descriptorArtifact = await artifactFixture(descriptorMismatch);
		seedStaging(descriptorMismatch, descriptorArtifact.bytes);
		await expect(
			publish(descriptorMismatch, {
				...descriptorArtifact.artifact,
				segment: {
					...descriptorArtifact.artifact.segment,
					ffmpegVersion: 'other',
				},
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('INVALID_ARTIFACT'));

		sqlite?.close();
		sqlite = undefined;
		const wrongOwner = await publicationFixture();
		const wrongOwnerArtifact = await artifactFixture(wrongOwner);
		seedStaging(wrongOwner, wrongOwnerArtifact.bytes);
		await expect(
			publish(wrongOwner, wrongOwnerArtifact.artifact, 'owner-2'),
		).rejects.toEqual(new TrackingArtifactPublicationError('COMMIT_FAILED'));

		sqlite?.close();
		sqlite = undefined;
		const stale = await publicationFixture();
		const staleArtifact = await artifactFixture(stale);
		seedStaging(stale, staleArtifact.bytes);
		await expect(
			publish(stale, {
				...staleArtifact.artifact,
				profileDigest: 'f'.repeat(64),
			}),
		).rejects.toEqual(new TrackingArtifactPublicationError('STALE_AUTHORITY'));

		sqlite?.close();
		sqlite = undefined;
		const cancelled = await publicationFixture();
		const cancelledArtifact = await artifactFixture(cancelled);
		seedStaging(cancelled, cancelledArtifact.bytes);
		await cancelled.authority.transitionAttempt({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			segmentId: SEGMENT_ID,
			attemptId: ATTEMPT_ID,
			leaseId: LEASE_ID,
			fence: 7,
			expectedState: 'output-ready',
			nextState: 'cancelled',
			progress: 90,
			safeFailureCode: null,
			updatedAt: START.toISOString(),
		});
		await expect(
			publish(cancelled, cancelledArtifact.artifact),
		).rejects.toEqual(new TrackingArtifactPublicationError('STALE_AUTHORITY'));
	});

	test('rejects rewritten staging and a conflicting accepted destination', async () => {
		const rewritten = await publicationFixture();
		const rewrittenArtifact = await artifactFixture(rewritten);
		seedStaging(rewritten, rewrittenArtifact.bytes);
		let reads = 0;
		const rewritingStore: TrackingArtifactStore = {
			read: async (key, maximumBytes, expectedEtag) => {
				reads += 1;
				if (reads === 2) rewritten.r2.seed(key, 'rewritten');
				return rewritten.store.read(key, maximumBytes, expectedEtag);
			},
			putIfAbsent: (key, bytes, checksum) =>
				rewritten.store.putIfAbsent(key, bytes, checksum),
			list: (prefix, cursor) => rewritten.store.list(prefix, cursor),
			delete: (keys) => rewritten.store.delete(keys),
		};
		const rewritingPublication = new TrackingArtifactPublication(
			rewritten.authority,
			rewritingStore,
			rewritten.lease,
			() => START,
		);
		await expect(
			rewritingPublication.publish({
				ownerId: OWNER_ID,
				transferRequestId: TRANSFER_ID,
				artifact: rewrittenArtifact.artifact,
			}),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('PROMOTION_CONFLICT'),
		);
		expect(rewritten.lease.beginCalls).toHaveLength(0);

		sqlite?.close();
		sqlite = undefined;
		const conflict = await publicationFixture();
		const conflictingArtifact = await artifactFixture(conflict);
		seedStaging(conflict, conflictingArtifact.bytes);
		conflict.r2.seed(
			acceptedEvidenceObjectKey(conflictingArtifact.artifact),
			'not-the-validated-bytes',
		);
		await expect(
			publish(conflict, conflictingArtifact.artifact),
		).rejects.toEqual(new TrackingArtifactPublicationError('INVALID_ARTIFACT'));
		expect(
			await conflict.authority.acceptedArtifactFor(
				OWNER_ID,
				RUN_ID,
				SEGMENT_ID,
			),
		).toBeNull();

		sqlite?.close();
		sqlite = undefined;
		const immutablePromotion = await publicationFixture();
		const firstArtifact = await artifactFixture(immutablePromotion);
		seedStaging(immutablePromotion, firstArtifact.bytes);
		immutablePromotion.lease.beginResult = { status: 'stale' };
		await expect(
			publish(immutablePromotion, firstArtifact.artifact),
		).rejects.toEqual(new TrackingArtifactPublicationError('STALE_AUTHORITY'));
		const differentArtifact = await artifactFixture(immutablePromotion, {
			gap: true,
		});
		seedStaging(immutablePromotion, differentArtifact.bytes);
		await expect(
			publish(immutablePromotion, differentArtifact.artifact),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('PROMOTION_CONFLICT'),
		);
	});

	test('keeps unreferenced promotions collectible and never deletes accepted evidence', async () => {
		const orphan = await publicationFixture();
		const orphanArtifact = await artifactFixture(orphan);
		seedStaging(orphan, orphanArtifact.bytes);
		orphan.lease.beginResult = { status: 'stale' };
		await expect(publish(orphan, orphanArtifact.artifact)).rejects.toEqual(
			new TrackingArtifactPublicationError('STALE_AUTHORITY'),
		);
		const cleanupAt = new Date(
			START.getTime() + TRACKING_ARTIFACT_GARBAGE_RETENTION_MS + 1,
		);
		const recentStagingKey =
			'tracking-staging/recent/recent/subject-observations.json.gz';
		orphan.r2.seed(
			recentStagingKey,
			'recent',
			{ contentType: 'application/octet-stream' },
			undefined,
			cleanupAt,
		);
		expect(await orphan.publication.cleanupDue(cleanupAt, 1)).toBe(1);
		expect(
			await orphan.store.read(
				acceptedEvidenceObjectKey(orphanArtifact.artifact),
				orphanArtifact.bytes.byteLength,
			),
		).toBeNull();
		expect(await orphan.publication.cleanupDue(cleanupAt, 1)).toBe(1);
		expect(
			await orphan.store.read(recentStagingKey, 'recent'.length),
		).not.toBeNull();
		expect(await orphan.publication.cleanupDue(cleanupAt)).toBe(0);

		sqlite?.close();
		sqlite = undefined;
		const accepted = await publicationFixture();
		const acceptedArtifact = await artifactFixture(accepted);
		seedStaging(accepted, acceptedArtifact.bytes);
		await publish(accepted, acceptedArtifact.artifact);
		expect(await accepted.publication.cleanupDue(cleanupAt)).toBe(1);
		expect(
			await accepted.store.read(
				acceptedEvidenceObjectKey(acceptedArtifact.artifact),
				acceptedArtifact.bytes.byteLength,
			),
		).not.toBeNull();
	});

	test('paginates bounded staging cleanup and maps cleanup failures', async () => {
		const value = await publicationFixture();
		const cleanupAt = new Date(
			START.getTime() + TRACKING_ARTIFACT_GARBAGE_RETENTION_MS + 1,
		);
		const deleted: string[][] = [];
		let pages = 0;
		const paginatedStore: TrackingArtifactStore = {
			read: (key, maximumBytes, expectedEtag) =>
				value.store.read(key, maximumBytes, expectedEtag),
			putIfAbsent: (key, bytes, checksum) =>
				value.store.putIfAbsent(key, bytes, checksum),
			list: async (_prefix, cursor) => {
				pages += 1;
				return cursor === undefined
					? {
							objects: [artifactListing('recent', cleanupAt)],
							cursor: 'next',
						}
					: {
							objects: [artifactListing('old', START)],
							cursor: null,
						};
			},
			delete: async (keys) => {
				deleted.push([...keys]);
			},
		};
		const publication = new TrackingArtifactPublication(
			value.authority,
			paginatedStore,
			value.lease,
			() => START,
		);
		expect(await publication.cleanupDue(cleanupAt, 2)).toBe(1);
		expect(pages).toBe(2);
		expect(deleted).toEqual([['tracking-staging/old']]);

		const safeFailure = new TrackingArtifactPublicationError('CLEANUP_FAILED');
		const failingStore = (error: Error): TrackingArtifactStore => ({
			read: (key, maximumBytes, expectedEtag) =>
				value.store.read(key, maximumBytes, expectedEtag),
			putIfAbsent: (key, bytes, checksum) =>
				value.store.putIfAbsent(key, bytes, checksum),
			list: async () => {
				throw error;
			},
			delete: (keys) => value.store.delete(keys),
		});
		await expect(
			new TrackingArtifactPublication(
				value.authority,
				failingStore(safeFailure),
				value.lease,
				() => START,
			).cleanupDue(cleanupAt),
		).rejects.toBe(safeFailure);
		await expect(
			new TrackingArtifactPublication(
				value.authority,
				failingStore(new Error('R2 unavailable')),
				value.lease,
				() => START,
			).cleanupDue(cleanupAt),
		).rejects.toEqual(new TrackingArtifactPublicationError('CLEANUP_FAILED'));
	});

	test('a cleanup claim wins safely over the final conditional commit', async () => {
		const value = await publicationFixture();
		const { artifact, bytes } = await artifactFixture(value);
		seedStaging(value, bytes);
		value.lease.onBegin = async () => {
			await value.publication.cleanupDue(
				new Date(START.getTime() + TRACKING_ARTIFACT_GARBAGE_RETENTION_MS + 1),
			);
		};
		await expect(publish(value, artifact)).rejects.toEqual(
			new TrackingArtifactPublicationError('STALE_AUTHORITY'),
		);
		expect(value.lease.holdReleaseCalls).toHaveLength(1);
		expect(
			await value.authority.acceptedArtifactFor(OWNER_ID, RUN_ID, SEGMENT_ID),
		).toBeNull();
	});

	test('reports bounded cleanup and lease release failures safely', async () => {
		const invalidCleanup = await publicationFixture();
		await expect(
			invalidCleanup.publication.cleanupDue(new Date('invalid')),
		).rejects.toEqual(new TrackingArtifactPublicationError('CLEANUP_FAILED'));
		await expect(
			invalidCleanup.publication.cleanupDue(START, 0),
		).rejects.toEqual(new TrackingArtifactPublicationError('CLEANUP_FAILED'));

		sqlite?.close();
		sqlite = undefined;
		const releaseFailure = await publicationFixture();
		const releaseArtifact = await artifactFixture(releaseFailure);
		seedStaging(releaseFailure, releaseArtifact.bytes);
		releaseFailure.lease.releaseResult = { status: 'stale' };
		await expect(
			publish(releaseFailure, releaseArtifact.artifact),
		).rejects.toEqual(
			new TrackingArtifactPublicationError('LEASE_RELEASE_FAILED'),
		);
		expect(
			await releaseFailure.authority.acceptedArtifactFor(
				OWNER_ID,
				RUN_ID,
				SEGMENT_ID,
			),
		).not.toBeNull();

		sqlite?.close();
		sqlite = undefined;
		const missingHold = await publicationFixture();
		const missingHoldArtifact = await artifactFixture(missingHold);
		seedStaging(missingHold, missingHoldArtifact.bytes);
		missingHold.lease.beginResult = { status: 'ok' };
		await expect(
			publish(missingHold, missingHoldArtifact.artifact),
		).rejects.toEqual(new TrackingArtifactPublicationError('STALE_AUTHORITY'));

		sqlite?.close();
		sqlite = undefined;
		const holdReleaseFailure = await publicationFixture();
		const holdReleaseArtifact = await artifactFixture(holdReleaseFailure);
		seedStaging(holdReleaseFailure, holdReleaseArtifact.bytes);
		holdReleaseFailure.lease.onBegin = async () => {
			await holdReleaseFailure.publication.cleanupDue(
				new Date(START.getTime() + TRACKING_ARTIFACT_GARBAGE_RETENTION_MS + 1),
			);
		};
		holdReleaseFailure.lease.holdReleaseError = new Error(
			'coordinator unavailable',
		);
		await expect(
			publish(holdReleaseFailure, holdReleaseArtifact.artifact),
		).rejects.toEqual(new TrackingArtifactPublicationError('COMMIT_FAILED'));
	});
});

const artifactListing = (name: string, uploaded: Date) => ({
	key: `tracking-staging/${name}`,
	version: `version-${name}`,
	etag: `etag-${name}`,
	uploaded,
	byteCount: 1,
});

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);

const digest = async (bytes: Uint8Array): Promise<string> => {
	const value = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};
