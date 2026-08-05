export type SetupOwner = { carId: string };
export type SetupCar = { archivedAt: string | null };

export const ownsSetup = (
	setup: SetupOwner | null | undefined,
	carId: string,
): boolean => setup?.carId === carId;

export const canWriteSetup = (car: SetupCar): boolean =>
	car.archivedAt === null;

export const copySetupSnapshot = <T extends Record<string, unknown>>(
	source: T,
	overrides: Partial<T> = {},
): T => structuredClone({ ...source, ...overrides });

export const shouldSelectCurrentSetup = (makeCurrent = false): boolean =>
	makeCurrent;

export const hasSourceMetadata = (value: {
	sourceUrl?: string | null;
	sourcePdfReference?: string | null;
	sourceMetadata?: unknown;
}): boolean =>
	Boolean(value.sourceUrl || value.sourcePdfReference || value.sourceMetadata);
