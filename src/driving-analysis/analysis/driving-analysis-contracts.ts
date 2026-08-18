import { z } from 'zod';
import { sha256Schema, uuidV4Schema } from '../tracking/contracts';
import { canonicalJson, float64Token } from '../tracking/inference-profile';

export const MAX_RACE_WINDOW_DURATION_MS = 15 * 60 * 1000;
export const MAX_ACTIVE_DRIVING_ANALYSES_PER_OWNER = 3;
export const MAX_DRIVING_ANALYSIS_CREATIONS_PER_HOUR = 20;
export const DRIVING_ANALYSIS_CREATION_WINDOW_MS = 60 * 60 * 1000;
export const FIXED_TRACK_VIEW = {
	x: 0,
	y: 1 / 3,
	width: 1,
	height: 2 / 3,
} as const;

const timestampSchema = z.number().int().safe().nonnegative();
const coordinateSchema = z.number().finite().min(0).max(1);
const normalizedSubjectBoxSchema = z
	.strictObject({
		x: coordinateSchema.lt(1),
		y: coordinateSchema.lt(1),
		width: coordinateSchema.positive(),
		height: coordinateSchema.positive(),
	})
	.refine(
		(box) =>
			box.x + box.width <= 1 &&
			box.y + box.height <= 1 &&
			box.width * box.height >= 1e-12,
		{ message: 'Subject box must be nondegenerate and inside the Track view' },
	);

export const createDrivingAnalysisInputSchema = z
	.strictObject({
		requestId: uuidV4Schema,
		raceVideoId: uuidV4Schema,
		approvedTrackMapVersionId: uuidV4Schema,
		raceWindow: z.strictObject({
			startTimestampMs: timestampSchema,
			endTimestampMs: timestampSchema.positive(),
		}),
		subjectSeed: z.strictObject({
			timestampMs: timestampSchema,
			frameIndex: z.number().int().nonnegative(),
			identity: z.string().trim().min(1).max(128),
			box: normalizedSubjectBoxSchema,
		}),
	})
	.superRefine((input, context) => {
		const duration =
			input.raceWindow.endTimestampMs - input.raceWindow.startTimestampMs;
		if (duration <= 0 || duration > MAX_RACE_WINDOW_DURATION_MS)
			context.addIssue({
				code: 'custom',
				path: ['raceWindow', 'endTimestampMs'],
				message: 'Race window must be positive and no longer than 15 minutes',
			});
		if (
			input.subjectSeed.timestampMs < input.raceWindow.startTimestampMs ||
			input.subjectSeed.timestampMs >= input.raceWindow.endTimestampMs
		)
			context.addIssue({
				code: 'custom',
				path: ['subjectSeed', 'timestampMs'],
				message: 'Subject seed must be inside the Race window',
			});
	});

export const drivingAnalysisWorkflowPayloadSchema = z.strictObject({
	kind: z.literal('analysis-creation.v1'),
	ownerId: z.string().min(1).max(128),
	analysisId: uuidV4Schema,
	expectedStateVersion: z.number().int().positive(),
});

export type CreateDrivingAnalysisInput = z.infer<
	typeof createDrivingAnalysisInputSchema
>;
export type DrivingAnalysisWorkflowPayload = z.infer<
	typeof drivingAnalysisWorkflowPayloadSchema
>;

export type PublicDrivingAnalysis = Readonly<{
	id: string;
	requestId: string;
	carId: string;
	driveSessionId: string;
	raceVideoId: string;
	raceWindow: Readonly<{
		startTimestampMs: number;
		endTimestampMs: number;
	}>;
	approvedTrackMapVersionId: string;
	subjectSeed: Readonly<{
		timestampMs: number;
		frameIndex: number;
		identity: string;
		box: Readonly<{ x: number; y: number; width: number; height: number }>;
	}>;
	sourceLayout: Readonly<{
		version: 'fixed-track-view.v1';
		digest: string;
		width: number;
		height: number;
		trackView: typeof FIXED_TRACK_VIEW;
	}>;
	lifecycle:
		| 'preparation'
		| 'tracking'
		| 'awaiting-reidentification'
		| 'tracking-complete'
		| 'failed'
		| 'completed'
		| 'cancelled';
	status:
		| 'queued'
		| 'running'
		| 'awaiting-reidentification'
		| 'completed'
		| 'failed'
		| 'cancelled'
		| 'deleting'
		| 'deleted';
	stage:
		| 'preparation'
		| 'tracking'
		| 'measurement'
		| 'clip-rendering'
		| 'finalization';
	progress: number;
	stateVersion: number;
	createdAt: string;
	updatedAt: string;
}>;

type DigestableCommand = Readonly<{
	ownerId: string;
	carId: string;
	driveSessionId: string;
	input: CreateDrivingAnalysisInput;
}>;

const hexDigest = async (bytes: Uint8Array): Promise<string> => {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};

export const digestDrivingAnalysisCommand = async (
	command: DigestableCommand,
): Promise<string> =>
	hexDigest(
		new TextEncoder().encode(
			canonicalJson({
				approvedTrackMapVersionId: command.input.approvedTrackMapVersionId,
				canonicalizationVersion: 'driving-analysis-command-c14n.v1',
				carId: command.carId,
				driveSessionId: command.driveSessionId,
				ownerId: command.ownerId,
				raceVideoId: command.input.raceVideoId,
				raceWindow: {
					endTimestampMs: String(command.input.raceWindow.endTimestampMs),
					startTimestampMs: String(command.input.raceWindow.startTimestampMs),
				},
				requestId: command.input.requestId,
				subjectSeed: {
					frameIndex: String(command.input.subjectSeed.frameIndex),
					identity: command.input.subjectSeed.identity,
					box: {
						height: float64Token(command.input.subjectSeed.box.height),
						width: float64Token(command.input.subjectSeed.box.width),
						x: float64Token(command.input.subjectSeed.box.x),
						y: float64Token(command.input.subjectSeed.box.y),
					},
					timestampMs: String(command.input.subjectSeed.timestampMs),
				},
			}),
		),
	);

export const digestFixedTrackViewLayout = async (
	width: number,
	height: number,
): Promise<string> => {
	const parsed = z
		.strictObject({
			width: z.number().int().positive(),
			height: z.number().int().positive(),
		})
		.parse({ width, height });
	return hexDigest(
		new TextEncoder().encode(
			canonicalJson({
				canonicalizationVersion: 'fixed-track-view-layout-c14n.v1',
				height: String(parsed.height),
				trackView: {
					height: float64Token(FIXED_TRACK_VIEW.height),
					width: float64Token(FIXED_TRACK_VIEW.width),
					x: float64Token(FIXED_TRACK_VIEW.x),
					y: float64Token(FIXED_TRACK_VIEW.y),
				},
				version: 'fixed-track-view.v1',
				width: String(parsed.width),
			}),
		),
	);
};

export const drivingAnalysisSourceLayoutDigestSchema = sha256Schema;
