import type {
	PreparedMediaArtifact,
	SubjectObservationSegment,
	SubjectProvenance,
	SubjectSeed,
} from '../tracking/contracts';
import { subjectObservationSegmentSchema } from '../tracking/contracts';
import type { InferenceProfile } from '../tracking/inference-profile';
import type { TrackingArtifactStore } from '../tracking/r2-tracking-artifact-store';
import {
	type PreparedFrameManifest,
	preparedFrameManifestSchema,
} from '../tracking/track-view-contracts';
import { subjectProvenanceForProfile } from '../tracking/tracking-artifact-publication';
import {
	CornerEvidenceError,
	type CornerEvidenceMeasurement,
	type EvidenceCorner,
	measureAcceptedSegment,
} from './corner-evidence';

export const EVIDENCE_MAX_COMPRESSED_INPUT_BYTES = 16 * 1024 * 1024;
export const EVIDENCE_MAX_OBSERVATION_CONTRACT_BYTES = 16 * 1024 * 1024;
export const EVIDENCE_MAX_MANIFEST_CONTRACT_BYTES = 8 * 1024 * 1024;

export type AcceptedCornerEvidenceIdentity = Readonly<{
	ownerId: string;
	analysisId: string;
	runId: string;
	workflowId: string;
	segmentId: string;
}>;

export type AcceptedCornerEvidenceContext = AcceptedCornerEvidenceIdentity &
	Readonly<{
		artifact: Readonly<{
			id: string;
			attemptId: string;
			profileDigest: string;
			specificationDigest: string;
			acceptedObjectKey: string;
			checksumSha256: string;
			contractDigest: string;
			byteCount: number;
			outcome: 'completed' | 'tracking-gap';
			gapJson: string | null;
			firstTimestampMs: number | null;
			lastTimestampMs: number | null;
			createdAt: string;
		}>;
		prepared: PreparedMediaArtifact;
		seed: SubjectSeed;
		profile: InferenceProfile;
		manifestObject: Readonly<{
			objectKey: string;
			byteCount: number;
			checksumSha256: string;
		}>;
		approvedTrackMapVersionId: string;
		corners: readonly EvidenceCorner[];
		existingMeasurement: CornerEvidenceMeasurement | null;
	}>;

export type CommitCornerEvidenceCommand = AcceptedCornerEvidenceIdentity &
	Readonly<{
		artifactId: string;
		attemptId: string;
		profileDigest: string;
		specificationDigest: string;
		preparedMediaId: string;
		observationObjectKey: string;
		observationChecksumSha256: string;
		observationContractDigest: string;
		manifestObjectKey: string;
		manifestChecksumSha256: string;
		approvedTrackMapVersionId: string;
		measurementInputDigest: string;
		measurementDigest: string;
		measurement: CornerEvidenceMeasurement;
		createdAt: string;
	}>;

export type CornerEvidenceCommitResult = Readonly<{
	status: 'committed' | 'replayed';
	measurement: CornerEvidenceMeasurement;
}>;

export interface CornerEvidenceAuthorityPort {
	load(
		identity: AcceptedCornerEvidenceIdentity,
	): Promise<AcceptedCornerEvidenceContext>;
	commit(
		command: CommitCornerEvidenceCommand,
	): Promise<CornerEvidenceCommitResult>;
}

export class AcceptedCornerEvidenceError extends Error {
	constructor(
		readonly code:
			| 'INVALID_ARTIFACT'
			| 'STALE_AUTHORITY'
			| 'RETRYABLE_INFRASTRUCTURE',
	) {
		super(code);
		this.name = 'AcceptedCornerEvidenceError';
	}
}

export class AcceptedCornerEvidence {
	constructor(
		private readonly authority: CornerEvidenceAuthorityPort,
		private readonly store: Pick<TrackingArtifactStore, 'read'>,
	) {}

	async commit(
		identity: AcceptedCornerEvidenceIdentity,
	): Promise<CornerEvidenceCommitResult> {
		try {
			return await this.commitValidated(identity);
		} catch (error) {
			if (error instanceof AcceptedCornerEvidenceError) throw error;
			if (error instanceof CornerEvidenceError)
				throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
			const authorityCode = errorCode(error);
			if (authorityCode === 'STALE_AUTHORITY')
				throw new AcceptedCornerEvidenceError(authorityCode);
			throw new AcceptedCornerEvidenceError('RETRYABLE_INFRASTRUCTURE');
		}
	}

	private async commitValidated(
		identity: AcceptedCornerEvidenceIdentity,
	): Promise<CornerEvidenceCommitResult> {
		const context = await this.authority.load(identity);
		if (context.existingMeasurement)
			return {
				status: 'replayed',
				measurement: context.existingMeasurement,
			};
		assertResourceBounds(context);
		const manifest = await this.readManifest(context);
		const segment = await this.readAcceptedSegment(context);
		assertManifestMatchesPrepared(manifest, context.prepared);
		await assertSegmentMatchesAuthority(segment, context);
		const measurement = measureAcceptedSegment({
			window: context.prepared.window,
			averageFrameRate: context.prepared.averageFrameRate,
			manifest,
			seed: context.seed,
			segment,
			corners: context.corners,
		});
		const measurementInputDigest = await digestCanonical({
			artifactId: context.artifact.id,
			attemptId: context.artifact.attemptId,
			observationChecksumSha256: context.artifact.checksumSha256,
			observationContractDigest: context.artifact.contractDigest,
			profileDigest: context.artifact.profileDigest,
			specificationDigest: context.artifact.specificationDigest,
			preparedMediaId: context.prepared.preparedMediaId,
			manifestChecksumSha256: context.manifestObject.checksumSha256,
			approvedTrackMapVersionId: context.approvedTrackMapVersionId,
			corners: context.corners,
			measurementVersion: measurement.version,
		});
		const measurementDigest = await digestCanonical(measurement);
		if (Number.isNaN(new Date(context.artifact.createdAt).getTime()))
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		return this.authority.commit({
			...identity,
			artifactId: context.artifact.id,
			attemptId: context.artifact.attemptId,
			profileDigest: context.artifact.profileDigest,
			specificationDigest: context.artifact.specificationDigest,
			preparedMediaId: context.prepared.preparedMediaId,
			observationObjectKey: context.artifact.acceptedObjectKey,
			observationChecksumSha256: context.artifact.checksumSha256,
			observationContractDigest: context.artifact.contractDigest,
			manifestObjectKey: context.manifestObject.objectKey,
			manifestChecksumSha256: context.manifestObject.checksumSha256,
			approvedTrackMapVersionId: context.approvedTrackMapVersionId,
			measurementInputDigest,
			measurementDigest,
			measurement,
			createdAt: context.artifact.createdAt,
		});
	}

	private async readAcceptedSegment(
		context: AcceptedCornerEvidenceContext,
	): Promise<SubjectObservationSegment> {
		const artifact = context.artifact;
		if (
			artifact.byteCount > EVIDENCE_MAX_COMPRESSED_INPUT_BYTES ||
			artifact.byteCount < 1
		)
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		const object = await this.store.read(
			artifact.acceptedObjectKey,
			artifact.byteCount,
		);
		if (
			!object ||
			object.byteCount !== artifact.byteCount ||
			(await sha256(object.bytes)) !== artifact.checksumSha256
		)
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		const bytes = await invalidArtifact(() =>
			decompressGzip(object.bytes, EVIDENCE_MAX_OBSERVATION_CONTRACT_BYTES),
		);
		if ((await sha256(bytes)) !== artifact.contractDigest)
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		return invalidArtifact(() =>
			subjectObservationSegmentSchema.parse(parseJson(bytes)),
		);
	}

	private async readManifest(
		context: AcceptedCornerEvidenceContext,
	): Promise<PreparedFrameManifest> {
		const descriptor = context.manifestObject;
		if (
			descriptor.byteCount > EVIDENCE_MAX_COMPRESSED_INPUT_BYTES ||
			descriptor.byteCount < 1 ||
			descriptor.byteCount !== context.prepared.frameManifestByteCount ||
			descriptor.checksumSha256 !== context.prepared.frameManifestChecksumSha256
		)
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		const object = await this.store.read(
			descriptor.objectKey,
			descriptor.byteCount,
		);
		if (
			!object ||
			object.byteCount !== descriptor.byteCount ||
			(await sha256(object.bytes)) !== descriptor.checksumSha256
		)
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		return invalidArtifact(async () =>
			preparedFrameManifestSchema.parse(
				parseJson(
					await decompressGzip(
						object.bytes,
						EVIDENCE_MAX_MANIFEST_CONTRACT_BYTES,
					),
				),
			),
		);
	}
}

const assertResourceBounds = (context: AcceptedCornerEvidenceContext): void => {
	if (
		context.artifact.byteCount + context.manifestObject.byteCount >
		EVIDENCE_MAX_COMPRESSED_INPUT_BYTES
	)
		throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
};

const assertSegmentMatchesAuthority = async (
	segment: SubjectObservationSegment,
	context: AcceptedCornerEvidenceContext,
): Promise<void> => {
	const first = segment.observations[0];
	const last = segment.observations.at(-1);
	const expectedProvenance = await subjectProvenanceForProfile(context.profile);
	if (
		segment.caseId !== context.prepared.caseId ||
		(segment.openGap === null ? 'completed' : 'tracking-gap') !==
			context.artifact.outcome ||
		(segment.openGap === null ? null : JSON.stringify(segment.openGap)) !==
			context.artifact.gapJson ||
		(first?.timestampMs ?? null) !== context.artifact.firstTimestampMs ||
		(last?.timestampMs ?? null) !== context.artifact.lastTimestampMs ||
		!provenanceMatches(segment.provenance, expectedProvenance)
	)
		throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
};

const assertManifestMatchesPrepared = (
	manifest: PreparedFrameManifest,
	prepared: PreparedMediaArtifact,
): void => {
	if (
		manifest.preparedMediaId !== prepared.preparedMediaId ||
		manifest.caseId !== prepared.caseId ||
		manifest.sourceChecksumSha256 !== prepared.sourceChecksumSha256 ||
		manifest.sourceByteCount !== prepared.sourceByteCount ||
		JSON.stringify(manifest.window) !== JSON.stringify(prepared.window) ||
		JSON.stringify(manifest.trackView) !== JSON.stringify(prepared.trackView) ||
		manifest.mediaByteCount !== prepared.byteCount ||
		manifest.mediaChecksumSha256 !== prepared.checksumSha256 ||
		manifest.width !== prepared.width ||
		manifest.height !== prepared.height ||
		JSON.stringify(manifest.averageFrameRate) !==
			JSON.stringify(prepared.averageFrameRate) ||
		manifest.ffmpegVersion !== prepared.ffmpegVersion ||
		manifest.pipelineVersion !== prepared.pipelineVersion ||
		manifest.preparationInputDigest !== prepared.preparationInputDigest ||
		manifest.preparationConfigurationDigest !==
			prepared.preparationConfigurationDigest ||
		manifest.frames.length !== prepared.decodedFrameCount
	)
		throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
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

const decompressGzip = async (
	bytes: Uint8Array,
	maximumBytes: number,
): Promise<Uint8Array> => {
	const reader = new Blob([bytes])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'))
		.getReader();
	const decompressed = new Uint8Array(maximumBytes);
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (total + value.byteLength > maximumBytes) {
			await reader.cancel();
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		}
		decompressed.set(value, total);
		total += value.byteLength;
	}
	return decompressed.subarray(0, total);
};

const invalidArtifact = async <T>(
	operation: () => T | Promise<T>,
): Promise<T> => {
	try {
		return await operation();
	} catch (error) {
		if (error instanceof AcceptedCornerEvidenceError) throw error;
		throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
	}
};

const errorCode = (error: unknown): unknown =>
	typeof error === 'object' && error !== null && 'code' in error
		? error.code
		: undefined;

const parseJson = (bytes: Uint8Array): unknown =>
	JSON.parse(
		new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
	);

const digestCanonical = async (value: unknown): Promise<string> =>
	sha256(new TextEncoder().encode(canonicalValue(value)));

const canonicalValue = (value: unknown): string => {
	if (value === null || typeof value === 'boolean')
		return JSON.stringify(value);
	if (typeof value === 'string') return JSON.stringify(value);
	if (typeof value === 'number') {
		/* c8 ignore next 2 -- strict contracts and the deterministic engine emit only finite numbers. */
		if (!Number.isFinite(value))
			throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
		const buffer = new ArrayBuffer(8);
		new DataView(buffer).setFloat64(0, value === 0 ? 0 : value);
		return JSON.stringify(
			`f64:${[...new Uint8Array(buffer)]
				.map((byte) => byte.toString(16).padStart(2, '0'))
				.join('')}`,
		);
	}
	if (Array.isArray(value))
		return `[${value.map((item) => canonicalValue(item)).join(',')}]`;
	if (typeof value === 'object')
		return `{${Object.entries(value)
			.sort(([left], [right]) => left.localeCompare(right))
			.map(([key, item]) => `${JSON.stringify(key)}:${canonicalValue(item)}`)
			.join(',')}}`;
	throw new AcceptedCornerEvidenceError('INVALID_ARTIFACT');
};

const sha256 = async (bytes: Uint8Array): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((value) => value.toString(16).padStart(2, '0'))
		.join('');
};
