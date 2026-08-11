import { and, eq, isNull, sql } from 'drizzle-orm';
import { car } from '../../schema';

export type SetupSelectionWitness = Readonly<{
	carId: string;
	ownerId: string;
	setupId?: string | null;
	version: number;
}>;

/** Match the complete selection observed by a setup mutation. */
export const setupSelectionWitness = (value: SetupSelectionWitness) =>
	and(
		eq(car.id, value.carId),
		eq(car.ownerId, value.ownerId),
		value.setupId == null
			? isNull(car.currentSetupId)
			: eq(car.currentSetupId, value.setupId),
		eq(car.currentSetupVersion, value.version),
	);

/** Advance the selection version in the same SQL statement as the selection. */
export const nextSetupSelectionVersion = () =>
	sql<number>`${car.currentSetupVersion} + 1`;
