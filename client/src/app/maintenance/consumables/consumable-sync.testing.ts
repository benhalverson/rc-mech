import type { ConsumableRecord } from '../../../../../shared/maintenance-sync';

const now = '2026-10-09T12:00:00.000Z';
export const tireRecord: ConsumableRecord = {
	id: 'tire',
	carId: 'car',
	kind: 'tires',
	performedAt: now,
	fluidArea: null,
	customFluidArea: null,
	frontDetails: '{"details":"Front pins"}',
	rearDetails: '{"details":"Rear pins"}',
	frontCost: 10,
	frontCurrency: 'USD',
	rearCost: 20,
	rearCurrency: 'USD',
	cost: null,
	currency: null,
	notes: null,
	prefilledFromSetupId: null,
	archivedAt: null,
	createdAt: now,
	updatedAt: now,
};
