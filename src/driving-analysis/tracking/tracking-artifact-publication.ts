import { z } from 'zod';
import {
	GPU_LEASE_COORDINATOR_OBJECT_NAME,
	type GpuLeaseHoldInput,
	type GpuLeaseHoldReleaseInput,
	type GpuLeaseMutationResult,
	type GpuLeaseReleaseInput,
} from '../gpu-lease-coordinator';
import {
	type OutputArtifact,
	outputArtifactSchema,
	type SubjectObservationSegment,
	type SubjectProvenance,
	subjectObservationSegmentSchema,
	uuidV4Schema,
} from './contracts';
import type { InferenceProfile } from './inference-profile';
import {
	type PrivateTrackingArtifactObject,
	R2TrackingArtifactStore,
	type TrackingArtifactStore,
	TrackingArtifactStoreError,
} from './r2-tracking-artifact-store';
import {
	type SubjectObservationArtifactRecord,
	type TrackingArtifactPublicationContext,
	TrackingAuthority,
	TrackingAuthorityError,
} from './tracking-authority';

export const TRACKING_ARTIFACT_MAX_COMPRESSED_BYTES = 64 * 1024 * 1024;
export const TRACKING_ARTIFACT_MAX_CONTRACT_BYTES = 64 * 1024 * 1024;
export const TRACKING_ARTIFACT_GARBAGE_RETENTION_MS = 24 * 60 * 60 * 1000;

const publishTrackingArtifactCommandSchema = z.strictObject({
	ownerId: z.string().trim().min(1).max(128),
	transferRequestId: uuidV4Schema,
	artifact: outputArtifactSchema,
});

export type PublishTrackingArtifactCommand = z.infer<
	typeof publishTrackingArtifactCommandSchema
>;

export type TrackingArtifactPublicationErrorCode =
	| 'INVALID_ARTIFACT'
	| 'STAGING_UNAVAILABLE'
	| 'STALE_AUTHORITY'
	| 'PROMOTION_CONFLICT'
	| 'COMMIT_FAILED'
	| 'LEASE_RELEASE_FAILED'
	| 'CLEANUP_FAILED';

export class TrackingArtifactPublicationError extends Error {
	constructor(readonly code: TrackingArtifactPublicationErrorCode) {
		super(code);
		this.name = 'TrackingArtifactPublicationError';
	}
}

interface CommitHoldCoordinator {
	beginCommitHold(input: GpuLeaseHoldInput): Promise<GpuLeaseMutationResult>;
	releaseCommitHold(
		input: GpuLeaseHoldReleaseInput,
	): Promise<GpuLeaseMutationResult>;
	release(input: GpuLeaseReleaseInput): Promise<GpuLeaseMutationResult>;
}

type ValidatedArtifact = {
	contractDigest: string;
	firstTimestampMs: number | null;
	lastTimestampMs: number | null;
	outcome: 'completed' | 'tracking-gap';
	gap: OutputArtifact['segment']['gap'];
};

export class TrackingArtifactPublication {
	constructor(
		private readonly authority: TrackingAuthority,
		private readonly store: TrackingArtifactStore,
		private readonly leaseCoordinator: CommitHoldCoordinator,
		private readonly now: () => Date = () => new Date(),
	) {}

	async publish(
		commandValue: PublishTrackingArtifactCommand,
	): Promise<SubjectObservationArtifactRecord> {
		const parsed = publishTrackingArtifactCommandSchema.safeParse(commandValue);
		if (!parsed.success)
			throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
		try {
			return await this.publishValidated(parsed.data);
		} catch (error) {
			throw safePublicationError(error);
		}
	}

	async cleanupDue(now = this.now(), limit = 100): Promise<number> {
		if (!(now instanceof Date) || Number.isNaN(now.getTime()))
			throw new TrackingArtifactPublicationError('CLEANUP_FAILED');
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new TrackingArtifactPublicationError('CLEANUP_FAILED');
		try {
			const candidates = await this.authority.cleanupPromotionCandidates(
				now.toISOString(),
				limit,
			);
			for (const candidate of candidates) {
				await this.store.delete([candidate.acceptedObjectKey]);
				await this.authority.markArtifactPromotionDeleted({
					artifactId: candidate.artifactId,
					expectedVersion: candidate.version,
					deletedAt: now.toISOString(),
				});
			}

			const stagingLimit = limit - candidates.length;
			const stagingKeys =
				stagingLimit === 0
					? []
					: await this.dueStagingKeys(
							new Date(now.getTime() - TRACKING_ARTIFACT_GARBAGE_RETENTION_MS),
							stagingLimit,
						);
			if (stagingKeys.length > 0) await this.store.delete(stagingKeys);
			return candidates.length + stagingKeys.length;
		} catch (error) {
			if (error instanceof TrackingArtifactPublicationError) throw error;
			throw new TrackingArtifactPublicationError('CLEANUP_FAILED');
		}
	}

	private async publishValidated(
		command: PublishTrackingArtifactCommand,
	): Promise<SubjectObservationArtifactRecord> {
		const { artifact } = command;
		const identity = publicationIdentity(command);
		const acceptedObjectKey = acceptedEvidenceObjectKey(artifact);
		const existing = await this.authority.acceptedArtifactFor(
			command.ownerId,
			artifact.runId,
			artifact.segmentId,
		);
		if (existing) {
			await this.validateAcceptedReplay(existing, artifact, acceptedObjectKey);
			await this.retrySuccessfulRelease(artifact);
			return existing;
		}

		const context = await this.authority.prepareArtifactPublication(identity);
		await validateDescriptor(artifact, context);
		const stagingObjectKey = stagingArtifactObjectKey(
			artifact.attemptId,
			command.transferRequestId,
		);
		const staged = await this.store.read(
			stagingObjectKey,
			TRACKING_ARTIFACT_MAX_COMPRESSED_BYTES,
		);
		if (!staged)
			throw new TrackingArtifactPublicationError('STAGING_UNAVAILABLE');
		const validated = await validateObject(staged, artifact);

		const stable = await this.store.read(
			stagingObjectKey,
			TRACKING_ARTIFACT_MAX_COMPRESSED_BYTES,
			staged.etag,
		);
		if (!stable)
			throw new TrackingArtifactPublicationError('STAGING_UNAVAILABLE');
		if (
			stable.version !== staged.version ||
			stable.byteCount !== staged.byteCount ||
			(await sha256(stable.bytes)) !== artifact.segment.checksumSha256
		)
			throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');

		const createdAt = this.now();
		const promotion = await this.authority.recordArtifactPromotion({
			...identity,
			artifactId: artifact.attemptId,
			stagingObjectKey,
			acceptedObjectKey,
			checksumSha256: artifact.segment.checksumSha256,
			contractDigest: validated.contractDigest,
			byteCount: artifact.segment.byteCount,
			deleteAfter: new Date(
				createdAt.getTime() + TRACKING_ARTIFACT_GARBAGE_RETENTION_MS,
			).toISOString(),
			createdAt: createdAt.toISOString(),
		});

		await this.store.putIfAbsent(
			acceptedObjectKey,
			stable.bytes,
			artifact.segment.checksumSha256,
		);
		const promoted = await this.store.read(
			acceptedObjectKey,
			TRACKING_ARTIFACT_MAX_COMPRESSED_BYTES,
		);
		if (!promoted)
			throw new TrackingArtifactPublicationError('PROMOTION_CONFLICT');
		const promotedValidation = await validateObject(promoted, artifact);

		await this.authority.markArtifactPromotionReady({
			ownerId: command.ownerId,
			runId: artifact.runId,
			segmentId: artifact.segmentId,
			attemptId: artifact.attemptId,
			leaseId: artifact.leaseId,
			fence: artifact.fencingToken,
			artifactId: artifact.attemptId,
			expectedVersion: promotion.version,
			updatedAt: this.now().toISOString(),
		});

		const hold = await this.leaseCoordinator.beginCommitHold(
			leaseIdentity(artifact),
		);
		if (hold.status !== 'ok' || !hold.holdId)
			throw new TrackingArtifactPublicationError('STALE_AUTHORITY');

		let accepted: SubjectObservationArtifactRecord;
		try {
			accepted = await this.authority.acceptArtifact({
				...identity,
				artifactId: artifact.attemptId,
				acceptedObjectKey,
				checksumSha256: artifact.segment.checksumSha256,
				contractDigest: promotedValidation.contractDigest,
				byteCount: artifact.segment.byteCount,
				outcome: promotedValidation.outcome,
				gap: promotedValidation.gap,
				firstTimestampMs: promotedValidation.firstTimestampMs,
				lastTimestampMs: promotedValidation.lastTimestampMs,
				createdAt: promotion.createdAt,
			});
		} catch (error) {
			await this.releaseHold(artifact, hold.holdId);
			throw error;
		}

		const released = await this.leaseCoordinator.release({
			...leaseIdentity(artifact),
			completed: true,
		});
		if (released.status !== 'ok')
			throw new TrackingArtifactPublicationError('LEASE_RELEASE_FAILED');
		return accepted;
	}

	private async validateAcceptedReplay(
		accepted: SubjectObservationArtifactRecord,
		artifact: OutputArtifact,
		acceptedObjectKey: string,
	): Promise<void> {
		const object = await this.store.read(
			acceptedObjectKey,
			TRACKING_ARTIFACT_MAX_COMPRESSED_BYTES,
		);
		if (!object)
			throw new TrackingArtifactPublicationError('PROMOTION_CONFLICT');
		const validated = await validateObject(object, artifact);
		if (
			accepted.id !== artifact.attemptId ||
			accepted.runId !== artifact.runId ||
			accepted.segmentId !== artifact.segmentId ||
			accepted.attemptId !== artifact.attemptId ||
			accepted.leaseId !== artifact.leaseId ||
			accepted.fence !== artifact.fencingToken ||
			accepted.profileDigest !== artifact.profileDigest ||
			accepted.specificationDigest !== artifact.specificationDigest ||
			accepted.acceptedObjectKey !== acceptedObjectKey ||
			accepted.checksumSha256 !== artifact.segment.checksumSha256 ||
			accepted.contractDigest !== validated.contractDigest ||
			accepted.byteCount !== artifact.segment.byteCount ||
			accepted.outcome !== validated.outcome ||
			accepted.gapJson !==
				(validated.gap === null ? null : JSON.stringify(validated.gap)) ||
			accepted.firstTimestampMs !== validated.firstTimestampMs ||
			accepted.lastTimestampMs !== validated.lastTimestampMs
		)
			throw new TrackingArtifactPublicationError('PROMOTION_CONFLICT');
	}

	private async retrySuccessfulRelease(
		artifact: OutputArtifact,
	): Promise<void> {
		try {
			await this.leaseCoordinator.release({
				...leaseIdentity(artifact),
				completed: true,
			});
		} catch {
			throw new TrackingArtifactPublicationError('LEASE_RELEASE_FAILED');
		}
	}

	private async releaseHold(
		artifact: OutputArtifact,
		holdId: string,
	): Promise<void> {
		try {
			await this.leaseCoordinator.releaseCommitHold({
				...leaseIdentity(artifact),
				holdId,
			});
		} catch {
			throw new TrackingArtifactPublicationError('COMMIT_FAILED');
		}
	}

	private async dueStagingKeys(cutoff: Date, limit: number): Promise<string[]> {
		const keys: string[] = [];
		let cursor: string | undefined;
		do {
			const page = await this.store.list('tracking-staging/', cursor);
			for (const object of page.objects) {
				if (object.uploaded <= cutoff) keys.push(object.key);
				if (keys.length === limit) return keys;
			}
			cursor = page.cursor ?? undefined;
		} while (cursor !== undefined);
		return keys;
	}
}

export type TrackingArtifactPublicationEnvironment = {
	DB: D1Database;
	ANALYSIS_MEDIA: R2Bucket;
	GPU_LEASE_COORDINATOR: {
		getByName(name: string): CommitHoldCoordinator;
	};
};

export const trackingArtifactPublication = (
	env: TrackingArtifactPublicationEnvironment,
): TrackingArtifactPublication =>
	new TrackingArtifactPublication(
		new TrackingAuthority(env.DB),
		new R2TrackingArtifactStore(env.ANALYSIS_MEDIA),
		env.GPU_LEASE_COORDINATOR.getByName(GPU_LEASE_COORDINATOR_OBJECT_NAME),
	);

export const stagingArtifactObjectKey = (
	attemptId: string,
	transferRequestId: string,
): string =>
	`tracking-staging/${attemptId}/${transferRequestId}/subject-observations.json.gz`;

export const acceptedEvidenceObjectKey = (artifact: OutputArtifact): string =>
	`tracking-evidence/${artifact.runId}/${artifact.segmentId}/${artifact.attemptId}/subject-observations.json.gz`;

const publicationIdentity = (command: PublishTrackingArtifactCommand) => ({
	ownerId: command.ownerId,
	runId: command.artifact.runId,
	segmentId: command.artifact.segmentId,
	attemptId: command.artifact.attemptId,
	leaseId: command.artifact.leaseId,
	fence: command.artifact.fencingToken,
	profileDigest: command.artifact.profileDigest,
	specificationDigest: command.artifact.specificationDigest,
	transferRequestId: command.transferRequestId,
});

const leaseIdentity = (artifact: OutputArtifact) => ({
	segmentId: artifact.segmentId,
	leaseId: artifact.leaseId,
	fence: artifact.fencingToken,
});

const validateDescriptor = async (
	artifact: OutputArtifact,
	context: TrackingArtifactPublicationContext,
): Promise<void> => {
	const expectedProvenance = await subjectProvenanceForProfile(context.profile);
	const segment = artifact.segment;
	const trackingInputDigest = await trackingInputDigestFor(
		context,
		artifact.segmentId,
		expectedProvenance,
	);
	if (
		segment.observationSegmentId !== artifact.segmentId ||
		segment.caseId !== context.prepared.caseId ||
		segment.ffmpegVersion !== context.prepared.ffmpegVersion ||
		segment.sourceChecksumSha256 !== context.prepared.sourceChecksumSha256 ||
		segment.preparedChecksumSha256 !== context.prepared.checksumSha256 ||
		segment.preparationConfigurationDigest !==
			context.prepared.preparationConfigurationDigest ||
		segment.trackingInputDigest !== trackingInputDigest ||
		!provenanceMatches(segment.provenance, expectedProvenance)
	)
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
};

export const subjectProvenanceForProfile = async (
	profile: InferenceProfile,
): Promise<SubjectProvenance> => {
	const withoutDigest = {
		provider: 'sam31',
		model: profile.model.name,
		modelVersion: profile.model.version,
		pipelineVersion: profile.pipeline.version,
		modelDigest: profile.model.digest,
		identityConfidenceThreshold: profile.identityConfidenceThreshold,
		confidenceCalibration: profile.confidenceCalibration,
	};
	const configurationJson = pythonCanonical(provenanceForDigest(withoutDigest));
	return {
		provider: withoutDigest.provider,
		model: withoutDigest.model,
		modelVersion: withoutDigest.modelVersion,
		pipelineVersion: withoutDigest.pipelineVersion,
		configurationDigest: await sha256(
			new TextEncoder().encode(configurationJson),
		),
		modelDigest: withoutDigest.modelDigest,
		identityConfidenceThreshold: withoutDigest.identityConfidenceThreshold,
		confidenceCalibration: withoutDigest.confidenceCalibration,
	};
};

export const trackingInputDigestFor = async (
	context: TrackingArtifactPublicationContext,
	segmentId: string,
	provenance: SubjectProvenance,
): Promise<string> =>
	sha256(
		new TextEncoder().encode(
			`${pythonCanonical({
				caseId: context.prepared.caseId,
				contractVersion: 'subject-tracking.v1',
				observationSegmentId: segmentId,
				prepared: preparedForDigest(context.prepared),
				providerProvenance: completeProvenanceForDigest(provenance),
				subjectSeed: seedForDigest(context.seed),
			})}\n`,
		),
	);

const pythonFloat = (value: number): string => {
	if (Object.is(value, -0)) return '-0.0';
	if (Number.isInteger(value)) return `${value}.0`;
	return String(value).replace(
		/e-(\d+)$/i,
		(_match, exponent) => `e-${String(exponent).padStart(2, '0')}`,
	);
};

class PythonFloatValue {
	constructor(readonly value: number) {}
}

const asPythonFloat = (value: number): PythonFloatValue =>
	new PythonFloatValue(value);

const pythonCanonical = (value: unknown): string => {
	if (typeof value === 'string') return pythonString(value);
	if (typeof value === 'number') {
		/* c8 ignore next 2 -- every plain number in the constructed digest payload is schema-bounded integer data. */
		if (!Number.isSafeInteger(value))
			throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
		return String(value);
	}
	if (value instanceof PythonFloatValue) return pythonFloat(value.value);
	/* c8 ignore next 2 -- digest payloads are constructed locally from strict object contracts and contain no unsupported values. */
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
	return `{${Object.entries(value)
		.sort(([left], [right]) => (left < right ? -1 : 1))
		.map(([key, item]) => `${pythonString(key)}:${pythonCanonical(item)}`)
		.join(',')}}`;
};

const pythonString = (value: string): string =>
	JSON.stringify(value)
		.split('')
		.map((character) =>
			character.charCodeAt(0) > 0x7f
				? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
				: character,
		)
		.join('');

const provenanceForDigest = (
	provenance: Omit<SubjectProvenance, 'configurationDigest'>,
) => ({
	confidenceCalibration: provenance.confidenceCalibration,
	identityConfidenceThreshold: asPythonFloat(
		provenance.identityConfidenceThreshold,
	),
	model: provenance.model,
	modelDigest: provenance.modelDigest,
	modelVersion: provenance.modelVersion,
	pipelineVersion: provenance.pipelineVersion,
	provider: provenance.provider,
});

const completeProvenanceForDigest = (provenance: SubjectProvenance) => ({
	...provenanceForDigest(provenance),
	configurationDigest: provenance.configurationDigest,
});

const preparedForDigest = (
	prepared: TrackingArtifactPublicationContext['prepared'],
) => ({
	...prepared,
	trackView: {
		x: asPythonFloat(prepared.trackView.x),
		y: asPythonFloat(prepared.trackView.y),
		width: asPythonFloat(prepared.trackView.width),
		height: asPythonFloat(prepared.trackView.height),
	},
});

const seedForDigest = (seed: TrackingArtifactPublicationContext['seed']) => ({
	...seed,
	box: {
		x: asPythonFloat(seed.box.x),
		y: asPythonFloat(seed.box.y),
		width: asPythonFloat(seed.box.width),
		height: asPythonFloat(seed.box.height),
	},
});

const validateObject = async (
	object: PrivateTrackingArtifactObject,
	artifact: OutputArtifact,
): Promise<ValidatedArtifact> => {
	if (
		object.byteCount !== artifact.segment.byteCount ||
		(await sha256(object.bytes)) !== artifact.segment.checksumSha256
	)
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
	const contractBytes = await decompressGzip(object.bytes);
	const contractDigest = await sha256(contractBytes);
	let contractValue: unknown;
	try {
		contractValue = JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
				contractBytes,
			),
		);
	} catch {
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
	}
	const parsed = subjectObservationSegmentSchema.safeParse(contractValue);
	if (!parsed.success || !contractMatchesDescriptor(parsed.data, artifact))
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
	const first = parsed.data.observations[0];
	const last = parsed.data.observations.at(-1);
	return {
		contractDigest,
		firstTimestampMs: first?.timestampMs ?? null,
		lastTimestampMs: last?.timestampMs ?? null,
		outcome: parsed.data.openGap === null ? 'completed' : 'tracking-gap',
		gap: parsed.data.openGap,
	};
};

const contractMatchesDescriptor = (
	contract: SubjectObservationSegment,
	artifact: OutputArtifact,
): boolean =>
	contract.caseId === artifact.segment.caseId &&
	contract.observations.length === artifact.segment.observationCount &&
	(contract.openGap === null) === artifact.segment.completed &&
	gapsMatch(contract.openGap, artifact.segment.gap) &&
	provenanceMatches(contract.provenance, artifact.segment.provenance);

const decompressGzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
	const reader = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'))
		.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > TRACKING_ARTIFACT_MAX_CONTRACT_BYTES) {
				await reader.cancel();
				throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
			}
			chunks.push(value);
		}
	} catch (error) {
		if (error instanceof TrackingArtifactPublicationError) throw error;
		throw new TrackingArtifactPublicationError('INVALID_ARTIFACT');
	}
	const decompressed = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		decompressed.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return decompressed;
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('');
};

const provenanceMatches = (
	left: SubjectProvenance,
	right: SubjectProvenance,
): boolean =>
	left.provider === right.provider &&
	left.model === right.model &&
	left.modelVersion === right.modelVersion &&
	left.pipelineVersion === right.pipelineVersion &&
	left.configurationDigest === right.configurationDigest &&
	left.modelDigest === right.modelDigest &&
	left.identityConfidenceThreshold === right.identityConfidenceThreshold &&
	left.confidenceCalibration === right.confidenceCalibration;

const gapsMatch = (
	left: OutputArtifact['segment']['gap'],
	right: OutputArtifact['segment']['gap'],
): boolean =>
	left === null
		? right === null
		: right !== null &&
			left.startTimestampMs === right.startTimestampMs &&
			left.reason === right.reason;

const safePublicationError = (
	error: unknown,
): TrackingArtifactPublicationError => {
	if (error instanceof TrackingArtifactPublicationError) return error;
	if (error instanceof TrackingArtifactStoreError)
		return new TrackingArtifactPublicationError(
			error.code === 'OBJECT_TOO_LARGE'
				? 'INVALID_ARTIFACT'
				: 'PROMOTION_CONFLICT',
		);
	if (error instanceof TrackingAuthorityError)
		return new TrackingArtifactPublicationError(
			error.code === 'CONFLICT'
				? 'PROMOTION_CONFLICT'
				: error.code === 'STALE_AUTHORITY' ||
						error.code === 'INVALID_TRANSITION'
					? 'STALE_AUTHORITY'
					: 'COMMIT_FAILED',
		);
	return new TrackingArtifactPublicationError('COMMIT_FAILED');
};
