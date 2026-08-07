export type PlanState = 'upcoming' | 'due' | 'overdue' | 'paused' | 'archived';

export type MaintenanceCar = {
	id: string;
	name: string;
	archivedAt?: string | null;
};

export type MaintenanceComponent = {
	id: string;
	carId: string;
	slot: string;
	name: string;
	removedAt?: string | null;
};

export type MaintenancePlan = {
	id: string;
	carId: string;
	componentId: string | null;
	name: string;
	intervalDays?: number | null;
	intervalUnit?: 'none' | 'days' | 'weeks' | 'months' | null;
	intervalValue?: number | null;
	intervalSessions?: number | null;
	baselineAt?: string | null;
	baselineSessionCount?: number | null;
	status: 'active' | 'paused' | 'archived';
	pausedAt?: string | null;
	nextDueAt?: string | null;
	dateDueAt?: string | null;
	nextDueSessionCount?: number | null;
	completedAt?: string | null;
	updatedAt?: string | null;
	dueStatus?: PlanState;
};

export type MaintenanceActivity = {
	id: string;
	planId?: string;
	action: string;
	occurredAt: string;
	note?: string | null;
};

export type ServiceRecord = {
	id: string;
	carId: string;
	componentId?: string | null;
	planId?: string | null;
	performedAt: string;
	description: string;
	notes?: string | null;
	cost?: number | null;
	currency?: string | null;
	deletedAt?: string | null;
};

export type FluidArea =
	| 'front-shocks'
	| 'rear-shocks'
	| 'front-differential'
	| 'rear-differential'
	| 'custom';

export type TireAxle = 'front' | 'rear' | 'both';

export type ConsumableEntry = {
	id: string;
	carId: string;
	kind: 'shock-fluid' | 'differential-fluid' | 'tires';
	performedAt: string;
	fluidArea?: FluidArea | null;
	customArea?: string | null;
	axle?: TireAxle | null;
	frontDetails?: string | null;
	rearDetails?: string | null;
	frontCost?: number | null;
	rearCost?: number | null;
	cost?: number | null;
	currency?: string | null;
	notes?: string | null;
	deletedAt?: string | null;
};
