import { describe, expect, test, vi } from 'vitest';
import { inferenceProfileFixture } from '../../testing/driving-analysis-tracking-fixtures';
import { MockR2Controller } from '../../testing/hono-fixture';
import type { SubjectProvenance } from '../tracking/contracts';
import { R2TrackingArtifactStore } from '../tracking/r2-tracking-artifact-store';
import type { PreparedFrameManifest } from '../tracking/track-view-contracts';
import { subjectProvenanceForProfile } from '../tracking/tracking-artifact-publication';
import {
	AcceptedCornerEvidence,
	AcceptedCornerEvidenceError,
	type CornerEvidenceAuthorityPort,
	EVIDENCE_MAX_COMPRESSED_INPUT_BYTES,
	EVIDENCE_MAX_OBSERVATION_CONTRACT_BYTES,
} from './accepted-corner-evidence';

const OWNER_ID = 'owner-1';
const ANALYSIS_ID = 'analysis-1';
const RUN_ID = '11111111-1111-4111-8111-111111111111';
const WORKFLOW_ID = 'workflow-1';
const SEGMENT_ID = '22222222-2222-4222-8222-222222222222';
const ARTIFACT_ID = '33333333-3333-4333-8333-333333333333';
const PREPARED_MEDIA_ID = '44444444-4444-4444-8444-444444444444';
const MAP_VERSION_ID = '55555555-5555-4555-8555-555555555555';
const OBSERVATION_KEY = `tracking-evidence/${RUN_ID}/${SEGMENT_ID}/${ARTIFACT_ID}/subject-observations.json.gz`;
const MANIFEST_KEY = `prepared/${PREPARED_MEDIA_ID}/frame-manifest.json.gz`;
const NOW = new Date('2026-08-18T19:00:00.000Z');

const manifest = (): PreparedFrameManifest => ({
	contractVersion: 'subject-tracking.v1',
	preparedMediaId: PREPARED_MEDIA_ID,
	caseId: RUN_ID,
	sourceChecksumSha256: '3'.repeat(64),
	sourceByteCount: 100,
	window: { startTimestampMs: 0, endTimestampMs: 400 },
	trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
	mediaByteCount: 50,
	mediaChecksumSha256: '4'.repeat(64),
	width: 160,
	height: 60,
	averageFrameRate: { numerator: 10, denominator: 1 },
	ffmpegVersion: '7.1.2',
	pipelineVersion: 'subject-tracking.v1',
	preparationInputDigest: '5'.repeat(64),
	preparationConfigurationDigest: '6'.repeat(64),
	frames: [
		{ preparedFrameIndex: 0, frameIndex: 1, timestampMs: 100 },
		{ preparedFrameIndex: 1, frameIndex: 2, timestampMs: 200 },
		{ preparedFrameIndex: 2, frameIndex: 3, timestampMs: 300 },
	],
});

const observations = (provenance: SubjectProvenance) => ({
	contractVersion: 'subject-observation-segment.v1' as const,
	outcome: 'accepted' as const,
	caseId: RUN_ID,
	observations: [
		{
			timestampMs: 100,
			frameIndex: 1,
			box: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 },
			center: { x: 0.2, y: 0.5 },
			visibility: 'visible' as const,
			identityConfidence: 0.99,
			origin: 'detected' as const,
			provenance,
		},
		{
			timestampMs: 200,
			frameIndex: 2,
			box: { x: 0.55, y: 0.45, width: 0.1, height: 0.1 },
			center: { x: 0.6, y: 0.5 },
			visibility: 'visible' as const,
			identityConfidence: 0.99,
			origin: 'detected' as const,
			provenance,
		},
		{
			timestampMs: 300,
			frameIndex: 3,
			box: { x: 0.85, y: 0.45, width: 0.1, height: 0.1 },
			center: { x: 0.9, y: 0.5 },
			visibility: 'visible' as const,
			identityConfidence: 0.99,
			origin: 'detected' as const,
			provenance,
		},
	],
	openGap: null,
	provenance,
});

const gzipBytes = async (bytes: Uint8Array): Promise<Uint8Array> =>
	new Uint8Array(
		await new Response(
			new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip')),
		).arrayBuffer(),
	);

const gzip = (value: unknown): Promise<Uint8Array> =>
	gzipBytes(new TextEncoder().encode(`${JSON.stringify(value)}\n`));

const digest = async (bytes: Uint8Array): Promise<string> => {
	const value = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(value)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

const fixture = async () => {
	const r2 = new MockR2Controller();
	const profile = inferenceProfileFixture();
	const provenance = await subjectProvenanceForProfile(profile);
	const observationEnvelope = observations(provenance);
	const observationBytes = await gzip(observationEnvelope);
	const manifestBytes = await gzip(manifest());
	r2.seed(OBSERVATION_KEY, observationBytes);
	r2.seed(MANIFEST_KEY, manifestBytes);
	const commit = vi.fn<CornerEvidenceAuthorityPort['commit']>(
		async (command) => ({
			status: 'committed',
			measurement: command.measurement,
		}),
	);
	const load = vi.fn<CornerEvidenceAuthorityPort['load']>(async () => ({
		ownerId: OWNER_ID,
		analysisId: ANALYSIS_ID,
		runId: RUN_ID,
		workflowId: WORKFLOW_ID,
		segmentId: SEGMENT_ID,
		artifact: {
			id: ARTIFACT_ID,
			attemptId: ARTIFACT_ID,
			profileDigest: '7'.repeat(64),
			specificationDigest: '8'.repeat(64),
			acceptedObjectKey: OBSERVATION_KEY,
			checksumSha256: await digest(observationBytes),
			contractDigest: await digest(
				new TextEncoder().encode(`${JSON.stringify(observationEnvelope)}\n`),
			),
			byteCount: observationBytes.byteLength,
			outcome: 'completed',
			gapJson: null,
			firstTimestampMs: 100,
			lastTimestampMs: 300,
			createdAt: NOW.toISOString(),
		},
		prepared: {
			preparedMediaId: PREPARED_MEDIA_ID,
			caseId: RUN_ID,
			byteCount: 50,
			checksumSha256: '4'.repeat(64),
			frameManifestByteCount: manifestBytes.byteLength,
			frameManifestChecksumSha256: await digest(manifestBytes),
			sourceByteCount: 100,
			sourceChecksumSha256: '3'.repeat(64),
			window: { startTimestampMs: 0, endTimestampMs: 400 },
			trackView: { x: 0, y: 1 / 3, width: 1, height: 2 / 3 },
			width: 160,
			height: 60,
			decodedFrameCount: 3,
			averageFrameRate: { numerator: 10, denominator: 1 },
			ffmpegVersion: '7.1.2',
			pipelineVersion: 'subject-tracking.v1',
			preparationInputDigest: '5'.repeat(64),
			preparationConfigurationDigest: '6'.repeat(64),
		},
		seed: {
			timestampMs: 100,
			frameIndex: 1,
			identity: 'subject-car',
			box: { x: 0.15, y: 0.45, width: 0.1, height: 0.1 },
		},
		profile,
		manifestObject: {
			objectKey: MANIFEST_KEY,
			byteCount: manifestBytes.byteLength,
			checksumSha256: await digest(manifestBytes),
		},
		approvedTrackMapVersionId: MAP_VERSION_ID,
		corners: [
			{
				id: '66666666-6666-4666-8666-666666666666',
				key: 'turn-one',
				order: 1,
				entryGate: {
					start: { x: 0.4, y: 1 },
					end: { x: 0.4, y: 0 },
					direction: 'forward',
				},
				exitGate: {
					start: { x: 0.75, y: 1 },
					end: { x: 0.75, y: 0 },
					direction: 'forward',
				},
			},
		],
		existingMeasurement: null,
	}));
	const authority: CornerEvidenceAuthorityPort = {
		load,
		commit,
	};
	const evidence = new AcceptedCornerEvidence(
		authority,
		new R2TrackingArtifactStore(r2.bucket),
	);
	return {
		authority,
		commit,
		evidence,
		load,
		r2,
		store: new R2TrackingArtifactStore(r2.bucket),
	};
};

const identity = {
	ownerId: OWNER_ID,
	analysisId: ANALYSIS_ID,
	runId: RUN_ID,
	workflowId: WORKFLOW_ID,
	segmentId: SEGMENT_ID,
};

describe('accepted corner evidence', () => {
	test('re-verifies accepted observations and the pinned manifest before commit', async () => {
		const value = await fixture();
		await expect(value.evidence.commit(identity)).resolves.toMatchObject({
			status: 'committed',
			measurement: {
				version: 'corner-evidence.v1',
				passes: [{ durationMs: 100, eligibility: 'eligible', rank: 1 }],
			},
		});
		expect(value.commit).toHaveBeenCalledWith(
			expect.objectContaining({
				artifactId: ARTIFACT_ID,
				approvedTrackMapVersionId: MAP_VERSION_ID,
				measurementInputDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				measurementDigest: expect.stringMatching(/^[0-9a-f]{64}$/),
				createdAt: NOW.toISOString(),
			}),
		);
		await expect(
			new AcceptedCornerEvidence(value.authority, value.store).commit(identity),
		).resolves.toMatchObject({ status: 'committed' });
		expect(value.commit.mock.calls.at(-1)?.[0].createdAt).toBe(
			NOW.toISOString(),
		);
	});

	test('rejects a changed accepted object without writing evidence', async () => {
		const value = await fixture();
		value.r2.seed(OBSERVATION_KEY, await gzip({ malformed: true }));
		await expect(value.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
		expect(value.commit).not.toHaveBeenCalled();
	});

	test('maps invalid accepted JSON to artifact corruption', async () => {
		const value = await fixture();
		const contractBytes = new TextEncoder().encode('{');
		const invalidJson = await gzipBytes(contractBytes);
		value.r2.seed(OBSERVATION_KEY, invalidJson);
		const context = await value.load(identity);
		value.load.mockResolvedValue({
			...context,
			artifact: {
				...context.artifact,
				byteCount: invalidJson.byteLength,
				checksumSha256: await digest(invalidJson),
				contractDigest: await digest(contractBytes),
			},
		});
		await expect(value.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
	});

	test('replays D1 evidence without rereading private objects', async () => {
		const value = await fixture();
		const context = await value.load(identity);
		const existingMeasurement = {
			version: 'corner-evidence.v1' as const,
			passes: [],
		};
		value.load.mockResolvedValue({ ...context, existingMeasurement });
		await value.r2.bucket.delete([OBSERVATION_KEY, MANIFEST_KEY]);
		await expect(value.evidence.commit(identity)).resolves.toEqual({
			status: 'replayed',
			measurement: existingMeasurement,
		});
		expect(value.commit).not.toHaveBeenCalled();
	});

	test('preserves stale authority and keeps infrastructure failures retryable', async () => {
		const stale = await fixture();
		stale.load.mockRejectedValue({ code: 'STALE_AUTHORITY' });
		await expect(stale.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('STALE_AUTHORITY'),
		);

		const unexpected = await fixture();
		unexpected.load.mockRejectedValue(new Error('private persistence detail'));
		await expect(unexpected.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('RETRYABLE_INFRASTRUCTURE'),
		);

		const storeFailure = await fixture();
		await expect(
			new AcceptedCornerEvidence(storeFailure.authority, {
				read: vi.fn().mockRejectedValue(new Error('private R2 failure')),
			}).commit(identity),
		).rejects.toEqual(
			new AcceptedCornerEvidenceError('RETRYABLE_INFRASTRUCTURE'),
		);

		const commitFailure = await fixture();
		commitFailure.commit.mockRejectedValue(new Error('private D1 failure'));
		await expect(commitFailure.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('RETRYABLE_INFRASTRUCTURE'),
		);
	});

	test.each([
		{ target: 'observation' as const, byteCount: 0 },
		{
			target: 'observation' as const,
			byteCount: EVIDENCE_MAX_COMPRESSED_INPUT_BYTES + 1,
		},
		{ target: 'manifest' as const, byteCount: 0 },
		{
			target: 'manifest' as const,
			byteCount: EVIDENCE_MAX_COMPRESSED_INPUT_BYTES + 1,
		},
	])('rejects invalid $target byte bounds: $byteCount', async (scenario) => {
		const value = await fixture();
		const context = await value.load(identity);
		value.load.mockResolvedValue(
			scenario.target === 'observation'
				? {
						...context,
						artifact: { ...context.artifact, byteCount: scenario.byteCount },
					}
				: {
						...context,
						manifestObject: {
							...context.manifestObject,
							byteCount: scenario.byteCount,
						},
					},
		);
		await expect(value.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
	});

	test.each(['observation', 'manifest'] as const)(
		'rejects a missing or digest-mismatched %s object',
		async (target) => {
			const missing = await fixture();
			await missing.r2.bucket.delete(
				target === 'observation' ? OBSERVATION_KEY : MANIFEST_KEY,
			);
			await expect(missing.evidence.commit(identity)).rejects.toEqual(
				new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
			);

			const mismatch = await fixture();
			const context = await mismatch.load(identity);
			mismatch.load.mockResolvedValue(
				target === 'observation'
					? {
							...context,
							artifact: {
								...context.artifact,
								checksumSha256: '0'.repeat(64),
							},
						}
					: {
							...context,
							manifestObject: {
								...context.manifestObject,
								checksumSha256: '0'.repeat(64),
							},
						},
			);
			await expect(mismatch.evidence.commit(identity)).rejects.toEqual(
				new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
			);
		},
	);

	test('rejects contract, provenance, manifest, and acceptance-time mismatches', async () => {
		const contract = await fixture();
		const contractContext = await contract.load(identity);
		contract.load.mockResolvedValue({
			...contractContext,
			artifact: {
				...contractContext.artifact,
				contractDigest: '0'.repeat(64),
			},
		});
		await expect(contract.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);

		const provenanceMismatch = await fixture();
		const provenanceContext = await provenanceMismatch.load(identity);
		provenanceMismatch.load.mockResolvedValue({
			...provenanceContext,
			profile: {
				...provenanceContext.profile,
				model: {
					...provenanceContext.profile.model,
					digest: '0'.repeat(64),
				},
			},
		});
		await expect(provenanceMismatch.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);

		const manifestMismatch = await fixture();
		const manifestContext = await manifestMismatch.load(identity);
		manifestMismatch.load.mockResolvedValue({
			...manifestContext,
			prepared: { ...manifestContext.prepared, width: 161 },
		});
		await expect(manifestMismatch.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);

		const invalidAcceptanceTime = await fixture();
		const invalidTimeContext = await invalidAcceptanceTime.load(identity);
		invalidAcceptanceTime.load.mockResolvedValue({
			...invalidTimeContext,
			artifact: { ...invalidTimeContext.artifact, createdAt: 'invalid' },
		});
		await expect(
			invalidAcceptanceTime.evidence.commit(identity),
		).rejects.toEqual(new AcceptedCornerEvidenceError('INVALID_ARTIFACT'));

		const invalidContinuity = await fixture();
		const continuityContext = await invalidContinuity.load(identity);
		invalidContinuity.load.mockResolvedValue({
			...continuityContext,
			seed: { ...continuityContext.seed, frameIndex: 99 },
		});
		await expect(invalidContinuity.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
	});

	test('rejects the aggregate input budget before reading private objects', async () => {
		const aggregate = await fixture();
		const aggregateContext = await aggregate.load(identity);
		aggregate.load.mockResolvedValue({
			...aggregateContext,
			artifact: {
				...aggregateContext.artifact,
				byteCount: EVIDENCE_MAX_COMPRESSED_INPUT_BYTES,
			},
		});
		const aggregateRead = vi.fn();
		const aggregateEvidence = new AcceptedCornerEvidence(aggregate.authority, {
			read: aggregateRead,
		});
		await expect(aggregateEvidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
		expect(aggregateRead).not.toHaveBeenCalled();
	});

	test('cancels decompression when an accepted contract exceeds its bound', async () => {
		const value = await fixture();
		const oversized = new Uint8Array(
			EVIDENCE_MAX_OBSERVATION_CONTRACT_BYTES + 1,
		);
		const compressed = await gzipBytes(oversized);
		value.r2.seed(OBSERVATION_KEY, compressed);
		const context = await value.load(identity);
		value.load.mockResolvedValue({
			...context,
			artifact: {
				...context.artifact,
				byteCount: compressed.byteLength,
				checksumSha256: await digest(compressed),
			},
		});
		await expect(value.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
	});

	test('rejects a non-JSON value from a corrupt authority adapter', async () => {
		const value = await fixture();
		const context = await value.load(identity);
		const corner = context.corners[0];
		if (!corner) throw new Error('missing corner fixture');
		value.load.mockResolvedValue({
			...context,
			corners: [{ ...corner, key: undefined as never }],
		});
		await expect(value.evidence.commit(identity)).rejects.toEqual(
			new AcceptedCornerEvidenceError('INVALID_ARTIFACT'),
		);
	});
});
