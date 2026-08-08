import { and, eq, isNull, or } from 'drizzle-orm';
import { db } from '../../db';
import { presentDateTime } from '../../drive-session-policy';
import { driveSession, owner } from '../../schema';
import type { AppContext } from '../../types';

export const ownerTimezone = async (c: AppContext): Promise<string> =>
	(
		await db(c.env)
			.select({ timezone: owner.timezone })
			.from(owner)
			.where(eq(owner.id, c.get('userId')))
			.get()
	)?.timezone ?? 'UTC';

export const publicDriveSession = (
	value: typeof driveSession.$inferSelect,
	timezone: string,
) => ({
	...value,
	...presentDateTime(value.startedAt, timezone),
});

export const driveSessionCount = async (c: AppContext, carId: string) => {
	const rows = await db(c.env)
		.select({ id: driveSession.id })
		.from(driveSession)
		.where(and(eq(driveSession.carId, carId), isNull(driveSession.deletedAt)));
	return rows.length;
};

export const sessionCountsForCars = async (c: AppContext, carIds: string[]) => {
	if (!carIds.length) return new Map<string, number>();
	const rows = await db(c.env)
		.select({ carId: driveSession.carId })
		.from(driveSession)
		.where(
			and(
				isNull(driveSession.deletedAt),
				or(...carIds.map((carId) => eq(driveSession.carId, carId))),
			),
		);
	const counts = new Map<string, number>();
	for (const row of rows)
		counts.set(row.carId, (counts.get(row.carId) ?? 0) + 1);
	return counts;
};
