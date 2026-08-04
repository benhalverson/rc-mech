export const STANDARD_COMPONENT_SLOTS = [
	'motor',
	'esc',
	'battery',
	'steering-servo',
	'throttle-servo',
	'receiver',
	'gyro',
	'transmitter',
	'tires',
	'wheels',
	'shocks',
	'front-differential',
	'center-differential',
	'rear-differential',
	'slipper-clutch',
	'pinion-gear',
	'spur-gear',
	'body',
	'wing',
] as const;

export type ComponentSlotType = 'standard' | 'custom';

export const normalizeComponentSlot = (slot: string): string =>
	slot.trim().toLowerCase().replaceAll(' ', '-');

export const componentSlotType = (
	slot: string,
	requested?: ComponentSlotType,
): ComponentSlotType | 'invalid' => {
	const standard = (STANDARD_COMPONENT_SLOTS as readonly string[]).includes(
		normalizeComponentSlot(slot),
	);
	if (requested === 'standard' && !standard) return 'invalid';
	if (requested === 'custom' && standard) return 'invalid';
	return requested ?? (standard ? 'standard' : 'custom');
};

export const ownsComponent = (
	componentCarId: string,
	ownedCarId: string,
): boolean => componentCarId === ownedCarId;

export const canEditComponent = (removedAt: string | null): boolean =>
	removedAt === null;
