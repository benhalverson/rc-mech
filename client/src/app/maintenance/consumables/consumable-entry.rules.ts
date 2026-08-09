import type {
	ConsumableEntry,
	ConsumableMaintenanceDraft,
	FluidArea,
	TireAxle,
} from '../maintenance.models';
import { localDateTime, localDateTimeToIso } from '../maintenance-time';
import type { ConsumableSaveCommand } from './consumable-store';

export type ConsumableEntryForm = {
	carId: string;
	kind: 'shock-fluid' | 'differential-fluid' | 'tires';
	performedAt: string;
	fluidArea: FluidArea;
	customArea: string;
	axle: TireAxle;
	frontDetails: string;
	rearDetails: string;
	frontCost: string;
	rearCost: string;
	notes: string;
};

export type ConsumableSaveMapping =
	| { readonly ok: true; readonly command: ConsumableSaveCommand }
	| { readonly ok: false; readonly message: string };

export const emptyConsumableEntryForm = (): ConsumableEntryForm => ({
	carId: '',
	kind: 'shock-fluid',
	performedAt: '',
	fluidArea: 'front-shocks',
	customArea: '',
	axle: 'front',
	frontDetails: '',
	rearDetails: '',
	frontCost: '',
	rearCost: '',
	notes: '',
});

export const newConsumableEntryForm = (
	carId: string,
	timezone: string,
	now: Date,
): ConsumableEntryForm => ({
	...emptyConsumableEntryForm(),
	carId,
	performedAt: localDateTime(now, timezone),
});

export const existingConsumableEntryForm = (
	entry: ConsumableEntry,
	timezone: string,
): ConsumableEntryForm => ({
	...emptyConsumableEntryForm(),
	carId: entry.carId,
	kind: entry.kind,
	performedAt: localDateTime(new Date(entry.performedAt), timezone),
	fluidArea: entry.fluidArea ?? 'front-shocks',
	customArea: entry.customArea ?? '',
	axle: entry.axle ?? 'front',
	frontDetails: entry.frontDetails ?? '',
	rearDetails: entry.rearDetails ?? '',
	frontCost:
		entry.kind === 'tires'
			? entry.frontCost == null
				? ''
				: String(entry.frontCost)
			: entry.cost == null
				? ''
				: String(entry.cost),
	rearCost: entry.rearCost == null ? '' : String(entry.rearCost),
	notes: entry.notes ?? '',
});

export const parseConsumableCost = (
	value: string,
): number | null | 'invalid' => {
	if (!value.trim()) return null;
	const number = Number(value);
	return Number.isFinite(number) && number >= 0 ? number : 'invalid';
};

export const hasConsumableTireSnapshot = (
	details: string,
	cost: string,
): boolean => Boolean(details.trim() || cost.trim());

const missingTireSnapshot = (form: Readonly<ConsumableEntryForm>): boolean =>
	form.kind === 'tires' &&
	((form.axle !== 'rear' &&
		!hasConsumableTireSnapshot(form.frontDetails, form.frontCost)) ||
		(form.axle !== 'front' &&
			!hasConsumableTireSnapshot(form.rearDetails, form.rearCost)));

export const mapConsumableSaveCommand = (
	form: Readonly<ConsumableEntryForm>,
	timezone: string,
	mode: 'create' | 'edit',
	id: string | null,
): ConsumableSaveMapping => {
	if (missingTireSnapshot(form))
		return {
			ok: false,
			message: 'Add front or rear tire details before saving.',
		};
	const frontCost = parseConsumableCost(form.frontCost);
	const rearCost = parseConsumableCost(form.rearCost);
	if (frontCost === 'invalid' || rearCost === 'invalid')
		return { ok: false, message: 'Costs must be zero or greater.' };
	const maintenance: ConsumableMaintenanceDraft =
		form.kind === 'tires'
			? {
					kind: form.kind,
					performedAt: localDateTimeToIso(form.performedAt, timezone),
					axle: form.axle,
					...(form.axle !== 'rear' && form.frontDetails.trim()
						? { frontDetails: form.frontDetails.trim() }
						: {}),
					...(form.axle !== 'rear' && frontCost !== null ? { frontCost } : {}),
					...(form.axle !== 'front' && form.rearDetails.trim()
						? { rearDetails: form.rearDetails.trim() }
						: {}),
					...(form.axle !== 'front' && rearCost !== null ? { rearCost } : {}),
					...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
				}
			: {
					kind: form.kind,
					performedAt: localDateTimeToIso(form.performedAt, timezone),
					fluidArea: form.fluidArea,
					...(form.fluidArea === 'custom' && form.customArea.trim()
						? { customArea: form.customArea.trim() }
						: {}),
					...(frontCost !== null ? { cost: frontCost } : {}),
					...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
				};
	return {
		ok: true,
		command: { kind: 'save', mode, carId: form.carId, id, maintenance },
	};
};
