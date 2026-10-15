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
		frameCount < 0 ||
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

type CornerPassFields = Pick<
	CornerPassEvidence,
	'entry' | 'exit' | 'durationMs' | 'eligibility' | 'exclusionReason'
>;

/** Construct an unranked pass with stable field order and explicit traversal fields. */
const createCornerPass = (
	corner: EvidenceCorner,
	ordinal: number,
	fields: CornerPassFields,
): CornerPassEvidence => ({
	cornerId: corner.id,
	cornerKey: corner.key,
	cornerOrder: corner.order,
	ordinal,
	entry: fields.entry,
	exit: fields.exit,
	durationMs: fields.durationMs,
	eligibility: fields.eligibility,
	exclusionReason: fields.exclusionReason,
	rank: null,
	tieGroup: null,
	best: false,
});

/** Measure traversals in event order, sharing the append budget across corners. */
const measureCorner = (
	corner: EvidenceCorner,
	segment: SubjectObservationSegment,
	tieToleranceMs: number,
	passBudget: { count: number },
): CornerPassEvidence[] => {
	const observations = segment.observations;
	const events: (
		| { kind: 'entry' | 'exit'; crossing: GateCrossing }
		| { kind: 'gap'; timestampMs: number }
	)[] = [];
	const gaps =
		segment.contractVersion === 'subject-observation-segment.v2'
			? segment.gaps
			: [];
	let gapIndex = 0;
	for (let index = 1; index < observations.length; index += 1) {
		const before = observations[index - 1];
		const after = observations[index];
		/* c8 ignore next -- the index bounds above establish both observations. */
		if (!before || !after) continue;
		const gap = gaps[gapIndex];
		if (
			gap &&
			gap.startTimestampMs > before.timestampMs &&
			gap.endTimestampMs <= after.timestampMs
		) {
			events.push({ kind: 'gap', timestampMs: gap.startTimestampMs });
			gapIndex += 1;
			continue;
		}
		const entry = crossing(before, after, corner.entryGate);
		if (entry) events.push({ kind: 'entry', crossing: entry });
		const exit = crossing(before, after, corner.exitGate);
		if (exit) events.push({ kind: 'exit', crossing: exit });
	}
	events.sort(
		(left, right) =>
			(left.kind === 'gap' ? left.timestampMs : left.crossing.timestampMs) -
			(right.kind === 'gap' ? right.timestampMs : right.crossing.timestampMs),
	);
	const passes: CornerPassEvidence[] = [];
	let entry: GateCrossing | null = null;
	let afterGap = false;
	for (const event of events) {
		if (event.kind === 'gap') {
			if (entry)
				appendPass(passes, passBudget, () =>
					createCornerPass(corner, passes.length + 1, {
						entry,
						exit: null,
						durationMs: null,
						eligibility: 'ineligible',
						exclusionReason: 'tracking-gap',
					}),
				);
			entry = null;
			afterGap = true;
			continue;
		}
		if (event.kind === 'entry') {
			if (entry)
				appendPass(passes, passBudget, () =>
					createCornerPass(corner, passes.length + 1, {
						entry,
						exit: null,
						durationMs: null,
						eligibility: 'ineligible',
						exclusionReason: 'gate-order',
					}),
				);
			entry = event.crossing;
			afterGap = false;
			continue;
		}
		if (!entry) {
			appendPass(passes, passBudget, () =>
				createCornerPass(corner, passes.length + 1, {
					entry: null,
					exit: event.crossing,
					durationMs: null,
					eligibility: 'ineligible',
					exclusionReason: afterGap ? 'tracking-gap' : 'gate-order',
				}),
			);
			continue;
		}
		appendPass(passes, passBudget, () =>
			createCornerPass(corner, passes.length + 1, {
				entry,
				exit: event.crossing,
				durationMs: event.crossing.timestampMs - entry.timestampMs,
				eligibility: 'eligible',
				exclusionReason: null,
			}),
		);
		entry = null;
	}
	if (entry) {
		appendPass(passes, passBudget, () =>
			createCornerPass(corner, passes.length + 1, {
				entry,
				exit: null,
				durationMs: null,
				eligibility: 'ineligible',
				exclusionReason:
					segment.openGap === null ? 'race-window' : 'tracking-gap',
			}),
		);
	}
	return rankCornerPasses(passes, tieToleranceMs);
};

/** Rank one corner across accepted segments without changing immutable batches. */
export const rankCornerPasses = <T extends CornerPassEvidence>(
	passes: readonly T[],
	tieToleranceMs: number,
): T[] => {
	const ranked = passes
		.filter(isEligiblePass)
		.sort(
			(left, right) =>
				left.durationMs - right.durationMs ||
				left.entry.timestampMs - right.entry.timestampMs,
		);
	const ranks = new Map<CornerPassEvidence, number>();
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
		ranks.set(pass, rank);
	}
	return passes.map((pass) => {
		const rank = ranks.get(pass) ?? null;
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
	const gaps =
		input.segment.contractVersion === 'subject-observation-segment.v2'
			? input.segment.gaps
			: [];
	let gapIndex = 0;
	let framePosition = seedIndex;
	for (const [index, observation] of input.segment.observations.entries()) {
		const gap = gaps[gapIndex];
		if (
			gap &&
			input.manifest.frames[framePosition]?.timestampMs === gap.startTimestampMs
		) {
			if (index === 0 || gap.endTimestampMs <= gap.startTimestampMs)
				throw new CornerEvidenceError('INVALID_OBSERVATIONS');
			while (
				framePosition < input.manifest.frames.length &&
				(input.manifest.frames[framePosition]?.timestampMs ?? Infinity) <
					gap.endTimestampMs
			) {
				framePosition += 1;
				if (framePosition - seedIndex > MAX_CORNER_EVIDENCE_FRAMES)
					throw new CornerEvidenceError('INVALID_OBSERVATIONS');
			}
			if (
				input.manifest.frames[framePosition]?.timestampMs !== gap.endTimestampMs
			)
				throw new CornerEvidenceError('INVALID_OBSERVATIONS');
			gapIndex += 1;
		}
		const frame = input.manifest.frames[framePosition];
		if (
			!frame ||
			frame.frameIndex !== observation.frameIndex ||
			frame.timestampMs !== observation.timestampMs ||
			observation.visibility !== 'visible' ||
			observation.identityConfidence <
				input.segment.provenance.identityConfidenceThreshold
		)
			throw new CornerEvidenceError('INVALID_OBSERVATIONS');
		framePosition += 1;
	}
	const nextFrame = input.manifest.frames[framePosition];
	if (
		gapIndex !== gaps.length ||
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
