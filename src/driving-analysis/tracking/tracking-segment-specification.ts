import type { CreateTrackingSegmentCommand } from './authority-contracts';
import type { PreparedMediaArtifact, SubjectSeed } from './contracts';
import { canonicalJson, float64Token } from './inference-profile';

export type TrackingSegmentSpecification = {
	contractVersion: 'tracking-segment-spec.v1';
	runId: string;
	segmentId: string;
	order: number;
	seedKind: 'initial' | 'reidentification';
	seedSourceId: string | null;
	seed: SubjectSeed;
	preparedMediaId: string;
	preparedMediaChecksum: string;
	frameManifestChecksum: string;
	preparationInputDigest: string;
	raceWindowEndTimestampMs: number;
	profileDigest: string;
	digest: string;
};

export const buildTrackingSegmentSpecification = async (
	command: CreateTrackingSegmentCommand,
	prepared: PreparedMediaArtifact,
	profileDigest: string,
): Promise<TrackingSegmentSpecification> => {
	const canonical = canonicalJson({
		contractVersion: command.specificationVersion,
		frameManifestChecksum: prepared.frameManifestChecksumSha256,
		order: integerToken(command.order),
		preparationInputDigest: prepared.preparationInputDigest,
		preparedMediaChecksum: prepared.checksumSha256,
		preparedMediaId: prepared.preparedMediaId,
		profileDigest,
		raceWindowEndTimestampMs: integerToken(prepared.window.endTimestampMs),
		runId: command.runId,
		seed: {
			box: {
				height: float64Token(command.seed.value.box.height),
				width: float64Token(command.seed.value.box.width),
				x: float64Token(command.seed.value.box.x),
				y: float64Token(command.seed.value.box.y),
			},
			frameIndex: integerToken(command.seed.value.frameIndex),
			identity: command.seed.value.identity,
			timestampMs: integerToken(command.seed.value.timestampMs),
		},
		seedKind: command.seed.kind,
		seedSourceId: command.seed.sourceId ?? 'none',
		segmentId: command.segmentId,
	});
	const digest = await sha256(new TextEncoder().encode(canonical));
	return {
		contractVersion: command.specificationVersion,
		runId: command.runId,
		segmentId: command.segmentId,
		order: command.order,
		seedKind: command.seed.kind,
		seedSourceId: command.seed.sourceId,
		seed: command.seed.value,
		preparedMediaId: prepared.preparedMediaId,
		preparedMediaChecksum: prepared.checksumSha256,
		frameManifestChecksum: prepared.frameManifestChecksumSha256,
		preparationInputDigest: prepared.preparationInputDigest,
		raceWindowEndTimestampMs: prepared.window.endTimestampMs,
		profileDigest,
		digest,
	};
};

const integerToken = (value: number): string => `i64:${value}`;

const sha256 = async (value: Uint8Array): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', value);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};
