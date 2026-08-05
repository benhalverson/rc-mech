export type ConsumableLifecycle = { archivedAt: string | null };

export const canEditConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt === null;
export const canArchiveConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt === null;
export const canRestoreConsumable = (value: ConsumableLifecycle): boolean =>
	value.archivedAt !== null;
export const ownsConsumable = (
	entryCarId: string | null | undefined,
	authorizedCarId: string,
): boolean => Boolean(entryCarId) && entryCarId === authorizedCarId;

type SetupTireValues = Record<string, unknown>;
const objectValue = (value: unknown): SetupTireValues | undefined =>
	value && typeof value === 'object' && !Array.isArray(value)
		? (value as SetupTireValues)
		: undefined;

export const mapSetupTiresToAxles = (value: unknown) => {
	const tires = objectValue(value);
	if (!tires) return { front: null, rear: null };
	const front = objectValue(tires.front ?? tires.frontTires);
	const rear = objectValue(tires.rear ?? tires.rearTires);
	return { front: front ?? tires, rear: rear ?? tires };
};
