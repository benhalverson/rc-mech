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

export type SetupCandidate = {
	id: string;
	updatedAt: string;
	createdAt: string;
};

/** Prefer the explicitly selected setup, then the newest setup as copy source. */
export const chooseCopySource = <T extends SetupCandidate>(
	candidates: readonly T[],
	currentSetupId?: string | null,
): T | undefined =>
	candidates.find((candidate) => candidate.id === currentSetupId) ??
	[...candidates].sort(
		(a, b) =>
			b.updatedAt.localeCompare(a.updatedAt) ||
			b.createdAt.localeCompare(a.createdAt),
	)[0];

export const shouldSelectCurrentSetup = (makeCurrent = false): boolean =>
	makeCurrent;

export const hasSourceMetadata = (value: {
	sourceUrl?: string | null;
	sourcePdfReference?: string | null;
	sourceMetadata?: unknown;
}): boolean =>
	Boolean(value.sourceUrl || value.sourcePdfReference || value.sourceMetadata);
