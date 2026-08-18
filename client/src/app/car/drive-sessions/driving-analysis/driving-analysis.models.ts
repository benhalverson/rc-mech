import type * as z from 'zod/mini';
import {
	int,
	literal,
	maximum,
	maxLength,
	minLength,
	nonnegative,
	number,
	pipe,
	positive,
	readonly,
	refine,
	strictObject,
	string,
	transform,
	union,
} from 'zod/mini';

export const MAX_RACE_WINDOW_DURATION_MS = 15 * 60 * 1000;

const coordinate = number().check(
	refine((value) => Number.isFinite(value)),
	nonnegative(),
	maximum(1),
);
const subjectBox = strictObject({
	x: coordinate,
	y: coordinate,
	width: coordinate.check(positive()),
	height: coordinate.check(positive()),
}).check(
	refine(
		(box) =>
			box.x < 1 &&
			box.y < 1 &&
			box.x + box.width <= 1 &&
			box.y + box.height <= 1 &&
			box.width * box.height >= 1e-12,
	),
);
const raceWindow = strictObject({
	startTimestampMs: int().check(nonnegative()),
	endTimestampMs: int().check(positive()),
}).check(
	refine(
		(window) =>
			window.endTimestampMs > window.startTimestampMs &&
			window.endTimestampMs - window.startTimestampMs <=
				MAX_RACE_WINDOW_DURATION_MS,
	),
);
const subjectSeed = strictObject({
	timestampMs: int().check(nonnegative()),
	frameIndex: int().check(nonnegative()),
	identity: string().check(minLength(1), maxLength(128)),
	box: subjectBox,
});
const fixedTrackView = strictObject({
	x: literal(0),
	y: literal(1 / 3),
	width: literal(1),
	height: literal(2 / 3),
});
const sourceLayout = strictObject({
	version: literal('fixed-track-view.v1'),
	digest: string().check(refine((value) => /^[0-9a-f]{64}$/.test(value))),
	width: int().check(positive()),
	height: int().check(positive()),
	trackView: fixedTrackView,
});

export const drivingAnalysisSchema = readonly(
	strictObject({
		id: string().check(minLength(1)),
		requestId: string().check(minLength(1)),
		carId: string().check(minLength(1)),
		driveSessionId: string().check(minLength(1)),
		raceVideoId: string().check(minLength(1)),
		raceWindow,
		approvedTrackMapVersionId: string().check(minLength(1)),
		subjectSeed,
		sourceLayout,
		lifecycle: union([
			literal('preparation'),
			literal('tracking'),
			literal('awaiting-reidentification'),
			literal('tracking-complete'),
			literal('failed'),
			literal('completed'),
			literal('cancelled'),
		]),
		status: union([
			literal('queued'),
			literal('running'),
			literal('awaiting-reidentification'),
			literal('completed'),
			literal('failed'),
			literal('cancelled'),
			literal('deleting'),
			literal('deleted'),
		]),
		stage: union([
			literal('preparation'),
			literal('tracking'),
			literal('measurement'),
			literal('clip-rendering'),
			literal('finalization'),
		]),
		progress: int().check(nonnegative(), maximum(100)),
		stateVersion: int().check(positive()),
		createdAt: string().check(minLength(1)),
		updatedAt: string().check(minLength(1)),
	}).check(
		refine(
			(analysis) =>
				analysis.subjectSeed.timestampMs >=
					analysis.raceWindow.startTimestampMs &&
				analysis.subjectSeed.timestampMs < analysis.raceWindow.endTimestampMs &&
				((analysis.status === 'queued' &&
					analysis.stage === 'preparation' &&
					analysis.progress === 0) ||
					(analysis.status === 'running' && analysis.progress < 100) ||
					(analysis.status === 'awaiting-reidentification' &&
						analysis.stage === 'tracking' &&
						analysis.progress < 100) ||
					(analysis.status === 'completed' &&
						analysis.stage === 'finalization' &&
						analysis.progress === 100) ||
					analysis.status === 'failed' ||
					analysis.status === 'cancelled' ||
					analysis.status === 'deleting' ||
					analysis.status === 'deleted'),
		),
	),
);

export const drivingAnalysisResponseSchema = pipe(
	strictObject({ drivingAnalysis: drivingAnalysisSchema }),
	transform((value) => value.drivingAnalysis),
);

export type DrivingAnalysis = z.infer<typeof drivingAnalysisSchema>;
export type SubjectBox = DrivingAnalysis['subjectSeed']['box'];

export type CreateDrivingAnalysisCommand = Readonly<{
	carId: string;
	driveSessionId: string;
	requestId: string;
	raceVideoId: string;
	approvedTrackMapVersionId: string;
	raceWindow: DrivingAnalysis['raceWindow'];
	subjectSeed: DrivingAnalysis['subjectSeed'];
}>;

export type StartDrivingAnalysisCommand = Omit<
	CreateDrivingAnalysisCommand,
	'requestId'
>;

export type DrivingAnalysisGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| {
			readonly kind: 'rejected-response';
			readonly status: number;
			readonly message: string;
	  }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' };
