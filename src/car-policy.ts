export type CarLifecycle = { archivedAt: string | null };

/** The owner scope is deliberately fail-closed for legacy rows without owner_id. */
export const ownsCar = (
	carOwnerId: string | null | undefined,
	authenticatedOwnerId: string,
): boolean => Boolean(carOwnerId) && carOwnerId === authenticatedOwnerId;

export const carListMode = (
	archived: string | undefined,
): 'active' | 'archived' | 'all' | 'invalid' => {
	if (archived === undefined) return 'active';
	if (archived === 'true') return 'archived';
	if (archived === 'all') return 'all';
	return 'invalid';
};

export const canArchive = (value: CarLifecycle): boolean =>
	value.archivedAt === null;
export const canRestore = (value: CarLifecycle): boolean =>
	value.archivedAt !== null;
export const canWrite = (value: CarLifecycle): boolean =>
	value.archivedAt === null;
