import type {
	ConsumableRecord,
	MaintenanceChange,
} from '../../../../../shared/maintenance-sync';
import type { ConsumableEntry } from '../maintenance.models';
import type { ConsumableCommand } from './consumable-store';

const details = (value: string | null): string | null => {
	if (value === null) return null;
	try {
		const parsed: unknown = JSON.parse(value);
		return typeof parsed === 'object' &&
			parsed !== null &&
			'details' in parsed &&
			typeof parsed.details === 'string'
			? parsed.details
			: value;
	} catch {
		return value;
	}
};
/**
 * Adapts canonical or pending Consumable records to the existing editor/report
 * model, keeping one presentation shape for online reads and the local working copy.
 */
export const consumableEntry = (record: ConsumableRecord): ConsumableEntry => ({
	id: record.id,
	carId: record.carId,
	kind:
		record.kind === 'tires'
			? 'tires'
			: record.fluidArea?.includes('shocks') ||
					(record.fluidArea === 'custom' &&
						record.customFluidArea?.toLowerCase().includes('shock'))
				? 'shock-fluid'
				: 'differential-fluid',
	performedAt: record.performedAt,
	fluidArea: record.fluidArea,
	customArea: record.customFluidArea,
	axle:
		record.kind === 'tires'
			? record.frontDetails && record.rearDetails
				? 'both'
				: record.frontDetails
					? 'front'
					: 'rear'
			: null,
	frontDetails: details(record.frontDetails),
	rearDetails: details(record.rearDetails),
	frontCost: record.frontCost,
	rearCost: record.rearCost,
	frontCurrency: record.frontCurrency,
	rearCurrency: record.rearCurrency,
	cost: record.cost,
	currency: record.currency,
	notes: record.notes,
	deletedAt: record.archivedAt,
});
/**
 * Converts an editor intent into a stable Consumable change with its comparison
 * base. Maintenance storage uses it for replay; tire/fluid history identity and
 * kind must remain unchanged when an existing entry is edited.
 */
export const consumableChange = (
	intent: ConsumableCommand,
	records: readonly ConsumableRecord[],
	entityId: string,
	version: number,
): Extract<MaintenanceChange, { entity: 'consumable' }> => {
	const id = intent.kind === 'save' ? intent.id : intent.entry.id;
	const base = records.find((record) => record.id === id) ?? null;
	if (id && !base) throw new Error('The Consumable entry is unavailable.');
	const carId = intent.kind === 'save' ? intent.carId : intent.entry.carId;
	let input: Extract<MaintenanceChange, { entity: 'consumable' }>['input'];
	if (intent.kind === 'save') {
		const draft = intent.maintenance;
		const tires = draft.kind === 'tires';
		input = {
			kind: tires ? 'tires' : 'fluid',
			performedAt: draft.performedAt,
			notes: draft.notes ?? null,
			fluidArea: tires ? null : draft.fluidArea,
			customFluidArea: tires ? null : (draft.customArea ?? null),
			frontDetails:
				tires && draft.axle !== 'rear'
					? JSON.stringify({ details: draft.frontDetails ?? '' })
					: null,
			rearDetails:
				tires && draft.axle !== 'front'
					? JSON.stringify({ details: draft.rearDetails ?? '' })
					: null,
			frontCost:
				tires && draft.axle !== 'rear' ? (draft.frontCost ?? null) : null,
			rearCost:
				tires && draft.axle !== 'front' ? (draft.rearCost ?? null) : null,
			frontCurrency:
				tires && draft.axle !== 'rear' && draft.frontCost !== undefined
					? 'USD'
					: null,
			rearCurrency:
				tires && draft.axle !== 'front' && draft.rearCost !== undefined
					? 'USD'
					: null,
			cost: tires ? null : (draft.cost ?? null),
			currency: !tires && draft.cost !== undefined ? 'USD' : null,
		};
	} else {
		if (!base) throw new Error('The Consumable entry is unavailable.');
		const {
			kind,
			performedAt,
			notes,
			fluidArea,
			customFluidArea,
			frontDetails,
			rearDetails,
			frontCost,
			rearCost,
			frontCurrency,
			rearCurrency,
			cost,
			currency,
		} = base;
		input = {
			kind,
			performedAt,
			notes,
			fluidArea,
			customFluidArea,
			frontDetails,
			rearDetails,
			frontCost,
			rearCost,
			frontCurrency,
			rearCurrency,
			cost,
			currency,
		};
	}
	return {
		type: 'maintenance.change',
		entity: 'consumable',
		carId,
		baseVersion: version,
		entryId: id ?? entityId,
		action: intent.kind === 'save' ? 'save' : intent.action,
		base,
		input,
	};
};
