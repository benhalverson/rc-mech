import type {
	SubjectObservationSegment,
	SubjectSeed,
} from '../tracking/contracts';
import { MAX_SUBJECT_OBSERVATIONS } from '../tracking/contracts';
import type { PreparedFrameManifest } from '../tracking/track-view-contracts';

type Point = Readonly<{ x: number; y: number }>;
type Gate = Readonly<{
	start: Point;
	end: Point;
	direction: 'forward' | 'reverse';
}>;

export type EvidenceCorner = Readonly<{
	id: string;
	key: string;
	order: number;
	entryGate: Gate;
	exitGate: Gate;
}>;

export type AcceptedSegmentMeasurementInput = Readonly<{
	window: Readonly<{ startTimestampMs: number; endTimestampMs: number }>;
	averageFrameRate: Readonly<{ numerator: number; denominator: number }>;
	manifest: PreparedFrameManifest;
	seed: SubjectSeed;
	segment: SubjectObservationSegment;
	corners: readonly EvidenceCorner[];
}>;

export type GateCrossing = Readonly<{
	timestampMs: number;
	beforeFrameIndex: number;
	afterFrameIndex: number;
}>;

export type CornerPassEvidence = Readonly<{
	cornerId: string;
	cornerKey: string;
	cornerOrder: number;
	ordinal: number;
	entry: GateCrossing | null;
	exit: GateCrossing | null;
	durationMs: number | null;
	eligibility: 'eligible' | 'ineligible';
	exclusionReason:
		| 'tracking-gap'
		| 'untrusted-crossing'
		| 'gate-order'
		| 'race-window'
		| null;
	rank: number | null;
	tieGroup: number | null;
	best: boolean;
}>;

export type CornerEvidenceMeasurement = Readonly<{
	version: 'corner-evidence.v1';
	passes: readonly CornerPassEvidence[];
}>;

export class CornerEvidenceError extends Error {
	constructor(readonly code: 'INVALID_OBSERVATIONS') {
		super(code);
		this.name = 'CornerEvidenceError';
	}
}

export const MAX_CORNER_EVIDENCE_FRAMES = MAX_SUBJECT_OBSERVATIONS;
export const MAX_CORNER_EVIDENCE_OPERATIONS = 10_000_000;
export const MAX_CORNER_EVIDENCE_PASSES = 10_000;

export const assertCornerEvidenceBudget = (
	frameCount: number,
	cornerCount: number,
): void => {
	if (
		!Number.isSafeInteger(frameCount) ||
		frameCount < 1 ||
		frameCount > MAX_CORNER_EVIDENCE_FRAMES ||
		!Number.isSafeInteger(cornerCount) ||
		cornerCount < 1 ||
		frameCount * cornerCount > MAX_CORNER_EVIDENCE_OPERATIONS
	)
		throw new CornerEvidenceError('INVALID_OBSERVATIONS');
};

type Observation = SubjectObservationSegment['observations'][number];

const cross = (left: Point, right: Point): number =>
	left.x * right.y - left.y * right.x;

const subtract = (left: Point, right: Point): Point => ({
	x: left.x - right.x,
	y: left.y - right.y,
});

const crossing = (
	before: Observation,
	after: Observation,
	gate: Gate,
): GateCrossing | null => {
	const gateVector = subtract(gate.end, gate.start);
	const beforeSide = cross(gateVector, subtract(before.center, gate.start));
	const afterSide = cross(gateVector, subtract(after.center, gate.start));
	const directedCrossing =
		gate.direction === 'forward'
			? beforeSide < 0 && afterSide >= 0
			: beforeSide > 0 && afterSide <= 0;
	if (!directedCrossing) return null;
	const movement = subtract(after.center, before.center);
	const denominator = cross(movement, gateVector);
	const offset = subtract(gate.start, before.center);
	const movementFraction = cross(offset, gateVector) / denominator;
	const gateFraction = cross(offset, movement) / denominator;
	if (gateFraction < 0 || gateFraction > 1) return null;
	return {
		timestampMs:
			before.timestampMs +
			(after.timestampMs - before.timestampMs) * movementFraction,
		beforeFrameIndex: before.frameIndex,
		afterFrameIndex: after.frameIndex,
	};
};

const measureCorner = (
	corner: EvidenceCorner,
	segment: SubjectObservationSegment,
	tieToleranceMs: number,
	passBudget: { count: number },
): CornerPassEvidence[] => {
	const observations = segment.observations;
	const events: { kind: 'entry' | 'exit'; crossing: GateCrossing }[] = [];
	for (let index = 1; index < observations.length; index += 1) {
		const before = observations[index - 1];
		const after = observations[index];
		/* c8 ignore next -- the index bounds above establish both observations. */
		if (!before || !after) continue;
		const entry = crossing(before, after, corner.entryGate);
		if (entry) events.push({ kind: 'entry', crossing: entry });
		const exit = crossing(before, after, corner.exitGate);
		if (exit) events.push({ kind: 'exit', crossing: exit });
	}
	events.sort(
		(left, right) => left.crossing.timestampMs - right.crossing.timestampMs,
	);
	const passes: CornerPassEvidence[] = [];
	let entry: GateCrossing | null = null;
	for (const event of events) {
		if (event.kind === 'entry') {
			if (entry)
				appendPass(passes, passBudget, () => ({
					cornerId: corner.id,
					cornerKey: corner.key,
					cornerOrder: corner.order,
					ordinal: passes.length + 1,
					entry,
					exit: null,
					durationMs: null,
					eligibility: 'ineligible',
					exclusionReason: 'gate-order',
					rank: null,
					tieGroup: null,
					best: false,
				}));
			entry = event.crossing;
			continue;
		}
		if (!entry) {
			appendPass(passes, passBudget, () => ({
				cornerId: corner.id,
				cornerKey: corner.key,
				cornerOrder: corner.order,
				ordinal: passes.length + 1,
				entry: null,
				exit: event.crossing,
				durationMs: null,
				eligibility: 'ineligible',
				exclusionReason: 'gate-order',
				rank: null,
				tieGroup: null,
				best: false,
			}));
			continue;
		}
		appendPass(passes, passBudget, () => ({
			cornerId: corner.id,
			cornerKey: corner.key,
			cornerOrder: corner.order,
			ordinal: passes.length + 1,
			entry,
			exit: event.crossing,
			durationMs: event.crossing.timestampMs - entry.timestampMs,
			eligibility: 'eligible',
			exclusionReason: null,
			rank: null,
			tieGroup: null,
			best: false,
		}));
		entry = null;
	}
	if (entry) {
		appendPass(passes, passBudget, () => ({
			cornerId: corner.id,
			cornerKey: corner.key,
			cornerOrder: corner.order,
			ordinal: passes.length + 1,
			entry,
			exit: null,
			durationMs: null,
			eligibility: 'ineligible',
			exclusionReason:
				segment.openGap === null ? 'race-window' : 'tracking-gap',
			rank: null,
			tieGroup: null,
			best: false,
		}));
	}
	const ranked = passes
		.filter(isEligiblePass)
		.sort(
			(left, right) =>
				left.durationMs - right.durationMs ||
				left.entry.timestampMs - right.entry.timestampMs,
		);
	const rankByOrdinal = new Map<number, number>();
	let rank = 0;
	let groupFastestDurationMs: number | null = null;
	for (const pass of ranked) {
		const durationMs = pass.durationMs;
		if (
			groupFastestDurationMs === null ||
			durationMs - groupFastestDurationMs > tieToleranceMs
		) {
			rank += 1;
			groupFastestDurationMs = durationMs;
		}
		rankByOrdinal.set(pass.ordinal, rank);
	}
	return passes.map((pass) => {
		const rank = rankByOrdinal.get(pass.ordinal) ?? null;
		return {
			...pass,
			rank,
			tieGroup: rank,
			best: rank === 1,
		};
	});
};

const appendPass = (
	passes: CornerPassEvidence[],
	budget: { count: number },
	create: () => CornerPassEvidence,
): void => {
	if (budget.count >= MAX_CORNER_EVIDENCE_PASSES)
		throw new CornerEvidenceError('INVALID_OBSERVATIONS');
	passes.push(create());
	budget.count += 1;
};

type EligiblePass = CornerPassEvidence & {
	eligibility: 'eligible';
	entry: GateCrossing;
	exit: GateCrossing;
	durationMs: number;
};

const isEligiblePass = (pass: CornerPassEvidence): pass is EligiblePass =>
	pass.eligibility === 'eligible';

const assertObservationContinuity = (
	input: AcceptedSegmentMeasurementInput,
): void => {
	const seedIndex = input.manifest.frames.findIndex(
		(frame) =>
			frame.frameIndex === input.seed.frameIndex &&
			frame.timestampMs === input.seed.timestampMs,
	);
	if (seedIndex < 0 || input.segment.caseId !== input.manifest.caseId)
		throw new CornerEvidenceError('INVALID_OBSERVATIONS');
	for (const [index, observation] of input.segment.observations.entries()) {
		const frame = input.manifest.frames[seedIndex + index];
		if (
			!frame ||
			frame.frameIndex !== observation.frameIndex ||
			frame.timestampMs !== observation.timestampMs ||
			observation.visibility !== 'visible' ||
			observation.identityConfidence <
				input.segment.provenance.identityConfidenceThreshold
		)
			throw new CornerEvidenceError('INVALID_OBSERVATIONS');
	}
	const nextFrame =
		input.manifest.frames[seedIndex + input.segment.observations.length];
	if (
		(input.segment.openGap === null && nextFrame !== undefined) ||
		(input.segment.openGap !== null &&
			(!nextFrame ||
				nextFrame.timestampMs !== input.segment.openGap.startTimestampMs))
	)
		throw new CornerEvidenceError('INVALID_OBSERVATIONS');
};

export const measureAcceptedSegment = (
	input: AcceptedSegmentMeasurementInput,
): CornerEvidenceMeasurement => {
	assertCornerEvidenceBudget(
		input.segment.observations.length,
		input.corners.length,
	);
	assertObservationContinuity(input);
	const tieToleranceMs =
		(1_000 * input.averageFrameRate.denominator) /
		input.averageFrameRate.numerator;
	if (!Number.isFinite(tieToleranceMs) || tieToleranceMs <= 0)
		throw new CornerEvidenceError('INVALID_OBSERVATIONS');
	const passBudget = { count: 0 };
	return {
		version: 'corner-evidence.v1',
		passes: input.corners.flatMap((corner) =>
			measureCorner(corner, input.segment, tieToleranceMs, passBudget),
		),
	};
};
