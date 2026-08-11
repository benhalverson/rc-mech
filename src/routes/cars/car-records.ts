import { and, eq } from 'drizzle-orm';
import { ownsCar } from '../../car-policy';
import {
	componentSlotType,
	normalizeComponentSlot,
} from '../../component-policy';
import { db } from '../../db';
import { car, component } from '../../schema';
import type { AppContext } from '../../types';

export const ownedCar = async (c: AppContext, carId: string) => {
	const value = await db(c.env)
		.select()
		.from(car)
		.where(and(eq(car.id, carId), eq(car.ownerId, c.get('userId'))))
		.get();
	return value && ownsCar(value.ownerId, c.get('userId')) ? value : undefined;
};

export const publicCar = (value: typeof car.$inferSelect) => {
	const {
		ownerId: _ownerId,
		lastOperationId: _lastOperationId,
		currentSetupOperationId: _currentSetupOperationId,
		...result
	} = value;
	return result;
};

export const ownedComponent = async (
	c: AppContext,
	carId: string,
	componentId: string,
) =>
	db(c.env)
		.select()
		.from(component)
		.where(and(eq(component.id, componentId), eq(component.carId, carId)))
		.get();

export const publicComponent = (value: typeof component.$inferSelect) => value;

export const parseComponentSlot = (
	slot: string,
	requested?: 'standard' | 'custom',
) => {
	const slotType = componentSlotType(slot, requested);
	return slotType === 'invalid'
		? undefined
		: {
				slot:
					slotType === 'standard' ? normalizeComponentSlot(slot) : slot.trim(),
				slotType,
			};
};
