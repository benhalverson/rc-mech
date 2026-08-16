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
import {
	preparedDescriptorFixture,
	preparedObjectsFixture,
	trackingRunInputFixture,
} from '../../testing/prepared-track-view-fixtures';
import { createSqliteD1, type SqliteD1Fixture } from '../../testing/sqlite-d1';
import type {
	AcceptTrackingArtifactCommand,
	ActivateTrackingAttemptCommand,
	CreateTrackingRunCommand,
	CreateTrackingSegmentCommand,
	PrepareTrackingTransferGrantCommand,
} from './authority-contracts';
import { PreparedTrackViewAuthority } from './prepared-track-view-authority';
import {
	TrackingAuthority,
	TrackingAuthorityError,
} from './tracking-authority';

const ANALYSIS_ID = 'analysis-1';
const OWNER_ID = 'owner-1';
const WORKFLOW_ID = 'workflow-1';
const NOW = '2026-08-16T20:00:00.000Z';
const LATER = '2026-08-16T20:01:00.000Z';
const SECOND_RUN_ID = '88888888-8888-4888-8888-888888888888';
const SECOND_SEGMENT_ID = '99999999-9999-4999-8999-999999999999';
const SECOND_ATTEMPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SECOND_LEASE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const ARTIFACT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const REIDENTIFICATION_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const OTHER_TRANSFER_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const INPUT_DIGEST =
	'b9fcffe729ec029ce020dc5e1583d9573579d6576ffd8bfc036e05ca77b8f133';

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

let fixture: SqliteD1Fixture | undefined;

afterEach(() => {
	fixture?.close();
	fixture = undefined;
});

const authorityFixture = () => {
	fixture = createSqliteD1();
	fixture.exec(migrations);
	return {
		authority: new TrackingAuthority(fixture.database),
		preparedAuthority: new PreparedTrackViewAuthority(fixture.database),
		database: fixture.database,
	};
};

const runCommand = (
	overrides: Partial<CreateTrackingRunCommand> = {},
): CreateTrackingRunCommand => ({
	runId: RUN_ID,
	analysisId: ANALYSIS_ID,
	ownerId: OWNER_ID,
	sequence: 1,
	workflowId: WORKFLOW_ID,
	profile: inferenceProfileFixture(),
	inputDigest: INPUT_DIGEST,
	createdAt: NOW,
	...overrides,
});

const seedPreparedTrackView = async (
	value: ReturnType<typeof authorityFixture>,
) => {
	await value.preparedAuthority.pinRunInput({
		ownerId: OWNER_ID,
		input: trackingRunInputFixture(),
		createdAt: NOW,
	});
	await value.preparedAuthority.acceptPreparedTrackView({
		ownerId: OWNER_ID,
		runId: RUN_ID,
		expectedRunVersion: 1,
		expectedInputDigest: INPUT_DIGEST,
		descriptor: preparedDescriptorFixture(INPUT_DIGEST, PREPARED_ID),
		objects: preparedObjectsFixture(PREPARED_ID),
		deleteAfter: '2026-08-17T20:00:00.000Z',
		createdAt: NOW,
	});
};

const segmentCommand = (
	overrides: Partial<CreateTrackingSegmentCommand> = {},
): CreateTrackingSegmentCommand => ({
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
	createdAt: NOW,
	...overrides,
});

const attemptCommand = (
	overrides: Partial<ActivateTrackingAttemptCommand> = {},
): ActivateTrackingAttemptCommand => ({
	ownerId: OWNER_ID,
	runId: RUN_ID,
	segmentId: SEGMENT_ID,
	attemptId: ATTEMPT_ID,
	leaseId: LEASE_ID,
	fence: 7,
	expectedCurrentAttemptId: null,
	createdAt: NOW,
	...overrides,
});

const attemptWitness = () => ({
	ownerId: OWNER_ID,
	runId: RUN_ID,
	segmentId: SEGMENT_ID,
	attemptId: ATTEMPT_ID,
	leaseId: LEASE_ID,
	fence: 7,
});

const artifactCommand = (
	overrides: Partial<AcceptTrackingArtifactCommand> = {},
): AcceptTrackingArtifactCommand => {
	const command = {
		ownerId: OWNER_ID,
		runId: RUN_ID,
		segmentId: SEGMENT_ID,
		attemptId: ATTEMPT_ID,
		leaseId: LEASE_ID,
		fence: 7,
		profileDigest: PROFILE_DIGEST,
		specificationDigest: '4'.repeat(64),
		transferRequestId: TRANSFER_ID,
		artifactId: ARTIFACT_ID,
		checksumSha256: 'a'.repeat(64),
		contractDigest: 'b'.repeat(64),
		byteCount: 20,
		outcome: 'completed' as const,
		gap: null,
		firstTimestampMs: 100,
		lastTimestampMs: 300,
		createdAt: LATER,
		...overrides,
	};
	return {
		...command,
		acceptedObjectKey:
			overrides.acceptedObjectKey ??
			`tracking-evidence/${command.runId}/${command.segmentId}/${command.attemptId}/subject-observations.json.gz`,
	};
};

const createSegmentAuthority = async () => {
	const value = authorityFixture();
	await value.authority.createRun(runCommand());
	await seedPreparedTrackView(value);
	const segment = await value.authority.createSegment(segmentCommand());
	return { ...value, segment };
};

const createAttemptAuthority = async () => {
	const value = await createSegmentAuthority();
	const attempt = await value.authority.activateAttempt(attemptCommand());
	return { ...value, attempt };
};

const transferGrantCommand = (
	specificationDigest: string,
	overrides: Partial<PrepareTrackingTransferGrantCommand> = {},
): PrepareTrackingTransferGrantCommand => ({
	...attemptWitness(),
	profileDigest: PROFILE_DIGEST,
	specificationDigest,
	transferRequestId: TRANSFER_ID,
	role: 'prepared-media',
	method: 'GET',
	requestedAt: NOW,
	...overrides,
});

const makeOutputReady = async (authority: TrackingAuthority) => {
	await authority.transitionAttempt({
		...attemptWitness(),
		expectedState: 'active',
		nextState: 'processing',
		progress: 20,
		safeFailureCode: null,
		updatedAt: LATER,
	});
	return authority.transitionAttempt({
		...attemptWitness(),
		expectedState: 'processing',
		nextState: 'output-ready',
		progress: 90,
		safeFailureCode: null,
		updatedAt: LATER,
	});
};

const preparePromotion = async (
	authority: TrackingAuthority,
	specificationDigest: string,
	commandOverrides: Partial<AcceptTrackingArtifactCommand> = {},
) => {
	const command = artifactCommand({
		specificationDigest,
		...commandOverrides,
	});
	await authority.authorizeTransferGrant(
		transferGrantCommand(specificationDigest, {
			role: 'observation-artifact',
			method: 'PUT',
		}),
	);
	const promotion = await authority.recordArtifactPromotion({
		...attemptWitness(),
		profileDigest: PROFILE_DIGEST,
		specificationDigest,
		transferRequestId: TRANSFER_ID,
		artifactId: command.artifactId,
		stagingObjectKey: `tracking-staging/${ATTEMPT_ID}/${TRANSFER_ID}/subject-observations.json.gz`,
		acceptedObjectKey: command.acceptedObjectKey,
		checksumSha256: command.checksumSha256,
		contractDigest: command.contractDigest,
		byteCount: command.byteCount,
		deleteAfter: '2026-08-17T20:01:00.000Z',
		createdAt: command.createdAt,
	});
	await authority.markArtifactPromotionReady({
		...attemptWitness(),
		artifactId: command.artifactId,
		expectedVersion: promotion.version,
		updatedAt: command.createdAt,
	});
	return command;
};

const expectAuthorityError = async (
	promise: Promise<unknown>,
	code: TrackingAuthorityError['code'],
) => {
	await expect(promise).rejects.toMatchObject({
		name: 'TrackingAuthorityError',
		code,
	});
};

describe('TrackingAuthority', () => {
	test('pins one canonical profile and makes run creation replay-safe', async () => {
		const { authority } = authorityFixture();
		const created = await authority.createRun(runCommand());
		expect(created).toMatchObject({
			id: RUN_ID,
			profileDigest: PROFILE_DIGEST,
			status: 'active',
			version: 1,
		});
		expect(await authority.createRun(runCommand())).toEqual(created);

		const changedProfile = inferenceProfileFixture();
		changedProfile.identityConfidenceThreshold = 0.4;
		await expectAuthorityError(
			authority.createRun(runCommand({ profile: changedProfile })),
			'CONFLICT',
		);
		const second = await authority.createRun(
			runCommand({
				runId: SECOND_RUN_ID,
				sequence: 2,
				workflowId: 'workflow-2',
				profile: changedProfile,
			}),
		);
		expect(second.profileDigest).not.toBe(PROFILE_DIGEST);
	});

	test('consumes complete prepared authority and keeps segment specifications immutable across replay', async () => {
		const value = authorityFixture();
		const { authority } = value;
		await authority.createRun(runCommand());
		await seedPreparedTrackView(value);
		const segment = await authority.createSegment(segmentCommand());
		expect(segment).toMatchObject({
			id: SEGMENT_ID,
			order: 0,
			profileDigest: PROFILE_DIGEST,
			specificationVersion: 'tracking-segment-spec.v1',
		});
		expect(segment.specificationDigest).toMatch(/^[0-9a-f]{64}$/);
		expect(await authority.createSegment(segmentCommand())).toEqual(segment);

		await expectAuthorityError(
			authority.createSegment(
				segmentCommand({ availabilityDeadlineAt: 2_000_000_001 }),
			),
			'CONFLICT',
		);
	});

	test('rejects segment seeds outside their prepared Race window or order', async () => {
		const value = authorityFixture();
		const { authority } = value;
		await authority.createRun(runCommand());
		await seedPreparedTrackView(value);
		await expectAuthorityError(
			authority.createSegment(
				segmentCommand({
					seed: {
						kind: 'initial',
						sourceId: null,
						value: {
							...submissionFixture().trackingRequest.subjectSeed,
							timestampMs: 400,
						},
					},
				}),
			),
			'CONFLICT',
		);
		await expectAuthorityError(
			authority.createSegment(segmentCommand({ order: 1 })),
			'CONFLICT',
		);
	});

	test('uses optimistic lease and fence witnesses for attempt replacement', async () => {
		const { authority } = await createAttemptAuthority();
		const activated = await authority.activateAttempt(attemptCommand());
		expect(activated.state).toBe('active');
		const processing = await authority.transitionAttempt({
			...attemptWitness(),
			expectedState: 'active',
			nextState: 'processing',
			progress: 25,
			safeFailureCode: null,
			updatedAt: LATER,
		});
		expect(
			await authority.transitionAttempt({
				...attemptWitness(),
				expectedState: 'active',
				nextState: 'processing',
				progress: 25,
				safeFailureCode: null,
				updatedAt: LATER,
			}),
		).toEqual(processing);

		const replacement = attemptCommand({
			attemptId: SECOND_ATTEMPT_ID,
			leaseId: SECOND_LEASE_ID,
			fence: 8,
			expectedCurrentAttemptId: ATTEMPT_ID,
			createdAt: LATER,
		});
		expect((await authority.activateAttempt(replacement)).state).toBe('active');
		await expectAuthorityError(
			authority.transitionAttempt({
				...attemptWitness(),
				expectedState: 'processing',
				nextState: 'output-ready',
				progress: 90,
				safeFailureCode: null,
				updatedAt: LATER,
			}),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.activateAttempt(
				attemptCommand({
					attemptId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
					leaseId: '12121212-1212-4212-8212-121212121212',
					fence: 8,
					expectedCurrentAttemptId: ATTEMPT_ID,
				}),
			),
			'STALE_AUTHORITY',
		);
	});

	test.each(['cancelled', 'expired', 'replaced'] as const)(
		'prevents a %s attempt from mutating authority',
		async (terminalState) => {
			const { authority } = await createAttemptAuthority();
			await authority.transitionAttempt({
				...attemptWitness(),
				expectedState: 'active',
				nextState: terminalState,
				progress: 1,
				safeFailureCode: null,
				updatedAt: LATER,
			});
			await expectAuthorityError(
				authority.recordTransferRequest({
					...attemptWitness(),
					transferRequestId: TRANSFER_ID,
					role: 'prepared-media',
					method: 'GET',
					objectScope: 'prepared-input',
					createdAt: NOW,
				}),
				'STALE_AUTHORITY',
			);
		},
	);

	test('persists stable transfer scope without accepting bearer capabilities', async () => {
		const { authority } = await createAttemptAuthority();
		const command = {
			...attemptWitness(),
			transferRequestId: TRANSFER_ID,
			role: 'prepared-media' as const,
			method: 'GET' as const,
			objectScope: 'prepared-input',
			createdAt: NOW,
		};
		const request = await authority.recordTransferRequest(command);
		expect(await authority.recordTransferRequest(command)).toEqual(request);
		await expectAuthorityError(
			authority.recordTransferRequest({
				...command,
				objectScope: 'different-input',
			}),
			'CONFLICT',
		);
		await expect(
			authority.recordTransferRequest({
				...command,
				transferRequestId: OTHER_TRANSFER_ID,
				role: 'observation-artifact',
				method: 'GET',
			}),
		).rejects.toThrow();
		const unsafeCommand = {
			...command,
			url: 'https://r2.example/object?signature=secret',
		};
		await expect(
			authority.recordTransferRequest(unsafeCommand),
		).rejects.toThrow();
		for (const unsafeScope of [
			'https://r2.example/object?signature=secret',
			'bad\\scope',
			'www.example',
		])
			await expect(
				authority.recordTransferRequest({
					...command,
					objectScope: unsafeScope,
				}),
			).rejects.toThrow();

		const granted = await authority.transitionTransferRequest({
			...attemptWitness(),
			transferRequestId: TRANSFER_ID,
			expectedState: 'required',
			nextState: 'granted',
			updatedAt: LATER,
		});
		expect(
			await authority.transitionTransferRequest({
				...attemptWitness(),
				transferRequestId: TRANSFER_ID,
				expectedState: 'required',
				nextState: 'granted',
				updatedAt: LATER,
			}),
		).toEqual(granted);
		expect(
			(
				await authority.transitionTransferRequest({
					...attemptWitness(),
					transferRequestId: TRANSFER_ID,
					expectedState: 'granted',
					nextState: 'completed',
					updatedAt: LATER,
				})
			).state,
		).toBe('completed');
	});

	test('resolves and authorizes exact prepared objects with replay-safe renewal', async () => {
		const { authority, segment } = await createAttemptAuthority();
		const command = transferGrantCommand(segment.specificationDigest);
		expect(await authority.prepareTransferGrant(command)).toEqual({
			objectKey: `prepared/${PREPARED_ID}/track-view.mp4`,
			contentType: 'video/mp4',
			role: 'prepared-media',
			method: 'GET',
		});
		const authorized = await authority.authorizeTransferGrant(command);
		expect(
			await authority.authorizeTransferGrant({
				...command,
				requestedAt: LATER,
			}),
		).toEqual(authorized);

		await expectAuthorityError(
			authority.prepareTransferGrant({
				...command,
				profileDigest: 'f'.repeat(64),
			}),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.prepareTransferGrant({
				...command,
				specificationDigest: 'e'.repeat(64),
			}),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.prepareTransferGrant({
				...command,
				ownerId: 'other-owner',
			}),
			'NOT_FOUND',
		);
	});

	test('issues only output-ready PUT scope and fences completed transfer replay', async () => {
		const { authority, segment } = await createAttemptAuthority();
		const outputCommand = transferGrantCommand(segment.specificationDigest, {
			role: 'observation-artifact',
			method: 'PUT',
		});
		await expectAuthorityError(
			authority.prepareTransferGrant(outputCommand),
			'INVALID_TRANSITION',
		);
		await makeOutputReady(authority);
		expect(await authority.authorizeTransferGrant(outputCommand)).toEqual({
			objectKey: `tracking-staging/${ATTEMPT_ID}/${TRANSFER_ID}/subject-observations.json.gz`,
			contentType: 'application/octet-stream',
			role: 'observation-artifact',
			method: 'PUT',
		});
		await authority.transitionTransferRequest({
			...attemptWitness(),
			transferRequestId: TRANSFER_ID,
			expectedState: 'granted',
			nextState: 'completed',
			updatedAt: LATER,
		});
		await expectAuthorityError(
			authority.authorizeTransferGrant({
				...outputCommand,
				requestedAt: LATER,
			}),
			'INVALID_TRANSITION',
		);
	});

	test('rejects transfer identity replay across exact roles and methods', async () => {
		const { authority, segment } = await createAttemptAuthority();
		const command = transferGrantCommand(segment.specificationDigest);
		await authority.prepareTransferGrant(command);
		await authority.transitionAttempt({
			...attemptWitness(),
			expectedState: 'active',
			nextState: 'transferring',
			progress: 1,
			safeFailureCode: null,
			updatedAt: LATER,
		});
		await expectAuthorityError(
			authority.prepareTransferGrant({
				...command,
				role: 'frame-manifest',
			}),
			'CONFLICT',
		);
		await expect(
			authority.prepareTransferGrant({
				...command,
				method: 'PUT',
			}),
		).rejects.toThrow();
	});

	test('accepts immutable evidence once and exposes only sanitized provenance', async () => {
		const { authority, segment } = await createAttemptAuthority();
		await makeOutputReady(authority);
		const command = await preparePromotion(
			authority,
			segment.specificationDigest,
		);
		const accepted = await authority.acceptArtifact(command);
		expect(await authority.acceptArtifact(command)).toEqual(accepted);
		const provenance = await authority.publicProvenance(
			OWNER_ID,
			ANALYSIS_ID,
			RUN_ID,
		);
		expect(provenance).toEqual({
			runId: RUN_ID,
			profileDigest: PROFILE_DIGEST,
			segments: [
				{
					segmentId: SEGMENT_ID,
					order: 0,
					outcome: 'completed',
					gap: null,
					artifact: {
						artifactId: ARTIFACT_ID,
						digest: 'a'.repeat(64),
						contractDigest: 'b'.repeat(64),
						byteCount: 20,
					},
				},
			],
		});
		const publicJson = JSON.stringify(provenance);
		for (const forbidden of [
			'attempt',
			'lease',
			'fence',
			'transfer',
			'objectKey',
			'hostname',
			'machine',
		])
			expect(publicJson).not.toContain(forbidden);
		await expectAuthorityError(
			authority.publicProvenance('owner-2', ANALYSIS_ID, RUN_ID),
			'NOT_FOUND',
		);
		await expectAuthorityError(
			authority.acceptArtifact(
				artifactCommand({ artifactId: OTHER_TRANSFER_ID }),
			),
			'CONFLICT',
		);
	});

	test('publishes an accepted Tracking gap without internal authority', async () => {
		const { authority, segment } = await createAttemptAuthority();
		await makeOutputReady(authority);
		const gap = {
			startTimestampMs: 250,
			reason: 'ambiguous-identity' as const,
		};
		await authority.acceptArtifact(
			await preparePromotion(authority, segment.specificationDigest, {
				outcome: 'tracking-gap',
				gap,
				firstTimestampMs: null,
				lastTimestampMs: null,
			}),
		);
		const provenance = await authority.publicProvenance(
			OWNER_ID,
			ANALYSIS_ID,
			RUN_ID,
		);
		expect(provenance.segments[0]?.gap).toEqual(gap);
	});

	test('requires one granted output transfer before publication', async () => {
		const { authority, segment } = await createAttemptAuthority();
		await makeOutputReady(authority);
		const command = transferGrantCommand(segment.specificationDigest, {
			role: 'observation-artifact',
			method: 'PUT',
		});
		const publicationCommand = {
			ownerId: command.ownerId,
			runId: command.runId,
			segmentId: command.segmentId,
			attemptId: command.attemptId,
			leaseId: command.leaseId,
			fence: command.fence,
			profileDigest: command.profileDigest,
			specificationDigest: command.specificationDigest,
			transferRequestId: command.transferRequestId,
		};
		await expectAuthorityError(
			authority.prepareArtifactPublication(publicationCommand),
			'NOT_FOUND',
		);
		await authority.prepareTransferGrant(command);
		await expectAuthorityError(
			authority.prepareArtifactPublication(publicationCommand),
			'INVALID_TRANSITION',
		);
		await authority.transitionTransferRequest({
			...attemptWitness(),
			transferRequestId: TRANSFER_ID,
			expectedState: 'required',
			nextState: 'granted',
			updatedAt: LATER,
		});
		expect(
			await authority.prepareArtifactPublication(publicationCommand),
		).toMatchObject({
			prepared: { preparedMediaId: PREPARED_ID },
			profile: { provider: 'local-sam31' },
			seed: submissionFixture().trackingRequest.subjectSeed,
		});
	});

	test('claims and terminally records only unreferenced promotion cleanup', async () => {
		const { authority, segment } = await createAttemptAuthority();
		await makeOutputReady(authority);
		const artifact = artifactCommand({
			specificationDigest: segment.specificationDigest,
		});
		await authority.authorizeTransferGrant(
			transferGrantCommand(segment.specificationDigest, {
				role: 'observation-artifact',
				method: 'PUT',
			}),
		);
		const promotionCommand = {
			...attemptWitness(),
			profileDigest: PROFILE_DIGEST,
			specificationDigest: segment.specificationDigest,
			transferRequestId: TRANSFER_ID,
			artifactId: artifact.artifactId,
			stagingObjectKey: `tracking-staging/${ATTEMPT_ID}/${TRANSFER_ID}/subject-observations.json.gz`,
			acceptedObjectKey: artifact.acceptedObjectKey,
			checksumSha256: artifact.checksumSha256,
			contractDigest: artifact.contractDigest,
			byteCount: artifact.byteCount,
			deleteAfter: LATER,
			createdAt: NOW,
		};
		const pending = await authority.recordArtifactPromotion(promotionCommand);
		await expectAuthorityError(
			authority.markArtifactPromotionReady({
				...attemptWitness(),
				artifactId: artifact.artifactId,
				expectedVersion: 2,
				updatedAt: LATER,
			}),
			'STALE_AUTHORITY',
		);
		const promoted = await authority.markArtifactPromotionReady({
			...attemptWitness(),
			artifactId: artifact.artifactId,
			expectedVersion: pending.version,
			updatedAt: LATER,
		});
		expect(
			await authority.markArtifactPromotionReady({
				...attemptWitness(),
				artifactId: artifact.artifactId,
				expectedVersion: promoted.version,
				updatedAt: LATER,
			}),
		).toEqual(promoted);
		await expectAuthorityError(
			authority.markArtifactPromotionReady({
				...attemptWitness(),
				artifactId: SECOND_ATTEMPT_ID,
				expectedVersion: 1,
				updatedAt: LATER,
			}),
			'NOT_FOUND',
		);
		await expectAuthorityError(
			authority.recordArtifactPromotion({
				...promotionCommand,
				checksumSha256: 'f'.repeat(64),
			}),
			'CONFLICT',
		);
		await expect(
			authority.cleanupPromotionCandidates('invalid'),
		).rejects.toThrow(RangeError);
		await expect(
			authority.cleanupPromotionCandidates(LATER, 0),
		).rejects.toThrow(RangeError);
		const [claimed] = await authority.cleanupPromotionCandidates(LATER);
		if (!claimed) throw new Error('Expected one cleanup claim');
		expect(claimed).toMatchObject({ state: 'deleting', version: 3 });
		expect(await authority.cleanupPromotionCandidates(LATER)).toEqual([
			claimed,
		]);
		await expectAuthorityError(
			authority.recordArtifactPromotion(promotionCommand),
			'STALE_AUTHORITY',
		);
		const deleted = await authority.markArtifactPromotionDeleted({
			artifactId: artifact.artifactId,
			expectedVersion: claimed.version,
			deletedAt: LATER,
		});
		expect(deleted.state).toBe('deleted');
		expect(
			await authority.markArtifactPromotionDeleted({
				artifactId: artifact.artifactId,
				expectedVersion: claimed.version,
				deletedAt: LATER,
			}),
		).toEqual(deleted);
		await expectAuthorityError(
			authority.markArtifactPromotionDeleted({
				artifactId: artifact.artifactId,
				expectedVersion: 99,
				deletedAt: LATER,
			}),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.recordArtifactPromotion(promotionCommand),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.acceptedArtifactFor(OWNER_ID, RUN_ID, SECOND_SEGMENT_ID),
			'NOT_FOUND',
		);
	});

	test('fails closed for missing ownership, parents, and invalid transitions', async () => {
		const value = authorityFixture();
		const { authority } = value;
		await authority.createRun(runCommand());
		await expectAuthorityError(
			authority.fenceRun({
				ownerId: 'different-owner',
				runId: RUN_ID,
				expectedVersion: 1,
				status: 'cancelled',
				completedAt: LATER,
			}),
			'NOT_FOUND',
		);
		await expectAuthorityError(
			authority.createSegment(segmentCommand()),
			'NOT_FOUND',
		);
		expect(
			await authority.publicProvenance(OWNER_ID, ANALYSIS_ID, RUN_ID),
		).toEqual({
			runId: RUN_ID,
			profileDigest: PROFILE_DIGEST,
			segments: [],
		});
		await seedPreparedTrackView(value);
		await expectAuthorityError(
			authority.activateAttempt(
				attemptCommand({ segmentId: SECOND_SEGMENT_ID }),
			),
			'NOT_FOUND',
		);
		await expectAuthorityError(
			authority.acceptArtifact(
				artifactCommand({ segmentId: SECOND_SEGMENT_ID }),
			),
			'NOT_FOUND',
		);
		await authority.createSegment(segmentCommand());
		expect(
			(await authority.publicProvenance(OWNER_ID, ANALYSIS_ID, RUN_ID))
				.segments[0]?.artifact,
		).toBeNull();
		await expectAuthorityError(
			authority.recordTransferRequest({
				...attemptWitness(),
				transferRequestId: TRANSFER_ID,
				role: 'prepared-media',
				method: 'GET',
				objectScope: 'prepared-input',
				createdAt: NOW,
			}),
			'NOT_FOUND',
		);
		await authority.activateAttempt(attemptCommand());
		await expectAuthorityError(
			authority.transitionAttempt({
				...attemptWitness(),
				expectedState: 'active',
				nextState: 'completed',
				progress: 1,
				safeFailureCode: null,
				updatedAt: LATER,
			}),
			'INVALID_TRANSITION',
		);
		await expectAuthorityError(
			authority.transitionAttempt({
				...attemptWitness(),
				leaseId: SECOND_LEASE_ID,
				expectedState: 'active',
				nextState: 'processing',
				progress: 1,
				safeFailureCode: null,
				updatedAt: LATER,
			}),
			'CONFLICT',
		);
		await expectAuthorityError(
			authority.acceptArtifact(artifactCommand()),
			'INVALID_TRANSITION',
		);
		await expectAuthorityError(
			authority.transitionTransferRequest({
				...attemptWitness(),
				transferRequestId: TRANSFER_ID,
				expectedState: 'required',
				nextState: 'granted',
				updatedAt: LATER,
			}),
			'NOT_FOUND',
		);
		await authority.recordTransferRequest({
			...attemptWitness(),
			transferRequestId: TRANSFER_ID,
			role: 'prepared-media',
			method: 'GET',
			objectScope: 'prepared-input',
			createdAt: NOW,
		});
		await expectAuthorityError(
			authority.transitionTransferRequest({
				...attemptWitness(),
				transferRequestId: TRANSFER_ID,
				expectedState: 'required',
				nextState: 'completed',
				updatedAt: LATER,
			}),
			'INVALID_TRANSITION',
		);
	});

	test('rejects profile collisions, cross-owner run IDs, and proposed attempts', async () => {
		const collision = authorityFixture();
		await collision.database
			.prepare(
				`INSERT INTO inference_profile (
					profile_digest,
					contract_version,
					canonicalization_version,
					configuration_json,
					created_at
				) VALUES (?, ?, ?, ?, ?)`,
			)
			.bind(
				PROFILE_DIGEST,
				'inference-profile.v1',
				'inference-profile-c14n.v1',
				'{}',
				NOW,
			)
			.run();
		await expectAuthorityError(
			collision.authority.createRun(runCommand()),
			'CONFLICT',
		);
		fixture?.close();
		fixture = undefined;

		const { authority, database } = await createSegmentAuthority();
		await expectAuthorityError(
			authority.createRun(
				runCommand({
					ownerId: 'different-owner',
					analysisId: 'different-analysis',
				}),
			),
			'NOT_FOUND',
		);
		const segment = await authority.createSegment(segmentCommand());
		await database
			.prepare(
				`INSERT INTO tracking_execution_attempt (
					id,
					segment_id,
					profile_digest,
					specification_digest,
					lease_id,
					fence,
					state,
					progress,
					version,
					created_at,
					updated_at
				) VALUES (?, ?, ?, ?, ?, ?, 'proposed', 0, 1, ?, ?)`,
			)
			.bind(
				ATTEMPT_ID,
				SEGMENT_ID,
				PROFILE_DIGEST,
				segment.specificationDigest,
				LEASE_ID,
				7,
				NOW,
				NOW,
			)
			.run();
		await expectAuthorityError(
			authority.activateAttempt(attemptCommand()),
			'STALE_AUTHORITY',
		);
	});

	test('rejects incomplete or reversed artifact timestamp bounds', async () => {
		const { authority } = await createAttemptAuthority();
		await makeOutputReady(authority);
		await expect(
			authority.acceptArtifact(
				artifactCommand({ firstTimestampMs: null, lastTimestampMs: 300 }),
			),
		).rejects.toThrow();
		await expect(
			authority.acceptArtifact(
				artifactCommand({ firstTimestampMs: 300, lastTimestampMs: 100 }),
			),
		).rejects.toThrow();
	});

	test('fences every late mutation after cancellation and replays the fence', async () => {
		const { authority } = await createAttemptAuthority();
		const fenced = await authority.fenceRun({
			ownerId: OWNER_ID,
			runId: RUN_ID,
			expectedVersion: 1,
			status: 'cancelled',
			completedAt: LATER,
		});
		expect(
			await authority.fenceRun({
				ownerId: OWNER_ID,
				runId: RUN_ID,
				expectedVersion: 1,
				status: 'cancelled',
				completedAt: LATER,
			}),
		).toEqual(fenced);
		await expectAuthorityError(
			authority.transitionAttempt({
				...attemptWitness(),
				expectedState: 'active',
				nextState: 'processing',
				progress: 10,
				safeFailureCode: null,
				updatedAt: LATER,
			}),
			'STALE_AUTHORITY',
		);
		await expectAuthorityError(
			authority.fenceRun({
				ownerId: OWNER_ID,
				runId: RUN_ID,
				expectedVersion: 1,
				status: 'replaced',
				completedAt: LATER,
			}),
			'STALE_AUTHORITY',
		);
	});

	test('enforces immutable database records below the gateway', async () => {
		const { authority, database, segment } = await createAttemptAuthority();
		await makeOutputReady(authority);
		await authority.acceptArtifact(
			await preparePromotion(authority, segment.specificationDigest),
		);
		for (const statement of [
			"UPDATE inference_profile SET contract_version = 'other'",
			"UPDATE tracking_run SET analysis_id = 'other'",
			"UPDATE prepared_tracking_media SET source_checksum = 'other'",
			"UPDATE tracking_segment SET seed_json = '{}'",
			"UPDATE tracking_execution_attempt SET lease_id = 'other'",
			"UPDATE tracking_transfer_request SET object_scope = 'other'",
			"UPDATE tracking_artifact_promotion SET accepted_object_key = 'other'",
			"UPDATE subject_observation_artifact SET accepted_object_key = 'other'",
			'DELETE FROM tracking_artifact_promotion',
			'DELETE FROM subject_observation_artifact',
		])
			await expect(database.prepare(statement).run()).rejects.toThrow(
				/immutable/,
			);
	});

	test('creates a Re-identification segment under the same run', async () => {
		const value = authorityFixture();
		const { authority } = value;
		await authority.createRun(runCommand());
		await seedPreparedTrackView(value);
		await authority.createSegment(segmentCommand());
		const segment = await authority.createSegment(
			segmentCommand({
				segmentId: SECOND_SEGMENT_ID,
				order: 1,
				seed: {
					kind: 'reidentification',
					sourceId: REIDENTIFICATION_ID,
					value: {
						...submissionFixture().trackingRequest.subjectSeed,
						timestampMs: 200,
						frameIndex: 2,
					},
				},
			}),
		);
		expect(segment).toMatchObject({
			order: 1,
			seedKind: 'reidentification',
			seedSourceId: REIDENTIFICATION_ID,
			profileDigest: PROFILE_DIGEST,
		});
	});
});
