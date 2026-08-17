import type { TrackCorner } from './track-map.models';

const finiteBounded = (value: number): boolean =>
	Number.isFinite(value) && value >= 0 && value <= 1;
const pointValid = (point: { x: number; y: number }): boolean =>
	finiteBounded(point.x) && finiteBounded(point.y);
const gateValid = (gate: TrackCorner['entryGate']): boolean =>
	pointValid(gate.start) &&
	pointValid(gate.end) &&
	(gate.start.x !== gate.end.x || gate.start.y !== gate.end.y);

export const validateTrackCorners = (
	corners: readonly TrackCorner[],
): string[] => {
	const errors: string[] = [];
	const keys = new Set<string>();
	const orders = new Set<number>();
	for (const corner of corners) {
		if (keys.has(corner.key))
			errors.push(`Corner key “${corner.key}” is duplicated.`);
		keys.add(corner.key);
		if (orders.has(corner.order))
			errors.push(`Corner order ${corner.order} is duplicated.`);
		orders.add(corner.order);
		if (!gateValid(corner.entryGate))
			errors.push(
				`${corner.name}: entry gate must have two distinct points inside the Track view.`,
			);
		if (!gateValid(corner.exitGate))
			errors.push(
				`${corner.name}: exit gate must have two distinct points inside the Track view.`,
			);
		const view = corner.cornerView;
		if (
			!pointValid(view) ||
			!finiteBounded(view.width) ||
			!finiteBounded(view.height) ||
			view.width <= 0 ||
			view.height <= 0 ||
			view.x + view.width > 1 ||
			view.y + view.height > 1
		)
			errors.push(
				`${corner.name}: Corner view must be a positive rectangle inside the Track view.`,
			);
	}
	return errors;
};
