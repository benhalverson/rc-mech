import { canonicalJson } from './inference-profile';
import {
	type TrackingRunInput,
	trackingRunInputSchema,
} from './track-view-contracts';

export const canonicalTrackingRunInput = (
	value: TrackingRunInput,
): Uint8Array => {
	const input = trackingRunInputSchema.parse(value);
	return new TextEncoder().encode(
		canonicalJson({
			approvedTrackMapVersionId: input.approvedTrackMapVersionId,
			canonicalizationVersion: 'tracking-run-input-c14n.v1',
			contractVersion: input.contractVersion,
			raceVideoId: input.raceVideoId,
			runId: input.runId,
			sourceByteCount: String(input.sourceByteCount),
			sourceChecksumSha256: input.sourceChecksumSha256,
			sourceLayout: {
				digest: input.sourceLayout.digest,
				height: String(input.sourceLayout.height),
				trackView: {
					height: 'f64:3fe5555555555555',
					width: 'f64:3ff0000000000000',
					x: 'f64:0000000000000000',
					y: 'f64:3fd5555555555555',
				},
				version: input.sourceLayout.version,
				width: String(input.sourceLayout.width),
			},
			sourceObjectKey: input.sourceObjectKey,
			window: {
				endTimestampMs: String(input.window.endTimestampMs),
				startTimestampMs: String(input.window.startTimestampMs),
			},
		}),
	);
};

export const digestTrackingRunInput = async (
	value: TrackingRunInput,
): Promise<string> => {
	const digest = await crypto.subtle.digest(
		'SHA-256',
		canonicalTrackingRunInput(value),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};
