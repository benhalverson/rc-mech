import { consumableMaintenanceEntry } from '../../schema';
import { publicConsumable } from './consumable-records';

// Translate the maintenance cockpit's legacy flat payload while keeping the
// canonical persisted model in its fluid-or-tire-set shape.
export const legacyConsumableInput = (body: Record<string, unknown>) => {
	if (body.kind === 'tires') {
		const axle =
			body.axle === 'rear' ? 'rear' : body.axle === 'both' ? 'both' : 'front';
		const front =
			axle !== 'rear' &&
			(body.frontDetails !== undefined || body.frontCost !== undefined)
				? {
						details: body.frontDetails,
						cost: body.frontCost,
						currency: body.frontCost === undefined ? undefined : 'USD',
					}
				: undefined;
		const rear =
			axle !== 'front' &&
			(body.rearDetails !== undefined || body.rearCost !== undefined)
				? {
						details: body.rearDetails,
						cost: body.rearCost,
						currency: body.rearCost === undefined ? undefined : 'USD',
					}
				: undefined;
		return {
			kind: 'tires',
			performedAt: body.performedAt,
			notes: body.notes,
			front,
			rear,
		};
	}
	const fluidKind =
		body.kind === 'shock-fluid'
			? (body.fluidArea ?? 'front-shocks')
			: body.kind === 'differential-fluid'
				? (body.fluidArea ?? 'front-differential')
				: body.fluidArea;
	return {
		kind: 'fluid',
		performedAt: body.performedAt,
		notes: body.notes,
		fluidArea: fluidKind,
		customFluidArea: body.customArea,
		cost: body.cost,
		currency: body.cost === undefined ? undefined : 'USD',
	};
};

export const legacyConsumableResponse = (
	value: typeof consumableMaintenanceEntry.$inferSelect,
) => ({
	consumableMaintenance: publicConsumable(value),
});
