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

export type MaintenancePlanDraft = {
	readonly carId: string;
	readonly componentId?: string;
	readonly name: string;
	readonly intervalUnit: 'none' | 'days' | 'weeks' | 'months';
	readonly intervalValue: number;
	readonly intervalDays?: number;
	readonly intervalSessions?: number;
	readonly baselineAt?: string;
	readonly baselineSessionCount: number;
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

export type ServiceRecordDraft = {
	readonly performedAt: string;
	readonly description: string;
	readonly notes?: string;
	readonly componentId?: string;
	readonly cost?: number;
	readonly currency?: string;
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

type ConsumableDraftBase = {
	readonly performedAt: string;
	readonly notes?: string;
};

export type ConsumableMaintenanceDraft =
	| (ConsumableDraftBase & {
			readonly kind: 'tires';
			readonly axle: TireAxle;
			readonly frontDetails?: string;
			readonly rearDetails?: string;
			readonly frontCost?: number;
			readonly rearCost?: number;
	  })
	| (ConsumableDraftBase & {
			readonly kind: 'shock-fluid' | 'differential-fluid';
			readonly fluidArea: FluidArea;
			readonly customArea?: string;
			readonly cost?: number;
	  });

export type MaintenanceReport = {
	tires: {
		frequency: {
			front: { eventCount: number; averageIntervalDays: number | null };
			rear: { eventCount: number; averageIntervalDays: number | null };
		};
		spend: {
			front: { total: number | null };
			rear: { total: number | null };
			combined: { total: number | null };
		};
	};
	fluidHistory: unknown[];
};

export type MaintenanceGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };
