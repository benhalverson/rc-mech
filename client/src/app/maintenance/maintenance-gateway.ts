import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import { array, custom, object } from 'zod/mini';
import type {
	ConsumableEntry,
	ConsumableMaintenanceDraft,
	MaintenanceActivity,
	MaintenanceCar,
	MaintenanceComponent,
	MaintenanceGatewayFailure,
	MaintenancePlan,
	MaintenancePlanDraft,
	MaintenanceReport,
	ServiceRecord,
	ServiceRecordDraft,
} from './maintenance.models';

class InvalidMaintenanceResponse extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const entity = <T>(required: readonly string[]) =>
	custom<T>((value) =>
		isRecord(value)
			? required.every((key) => typeof value[key] === 'string')
			: false,
	);

const carSchema = entity<MaintenanceCar>(['id', 'name']);
const componentSchema = entity<MaintenanceComponent>([
	'id',
	'carId',
	'slot',
	'name',
]);
const planSchema = entity<MaintenancePlan>(['id', 'carId', 'name', 'status']);
const activitySchema = entity<MaintenanceActivity>([
	'id',
	'action',
	'occurredAt',
]);
const serviceSchema = entity<ServiceRecord>([
	'id',
	'carId',
	'performedAt',
	'description',
]);
const consumableSchema = entity<ConsumableEntry>([
	'id',
	'carId',
	'kind',
	'performedAt',
]);
const reportSchema = custom<MaintenanceReport>(
	(value) => isRecord(value) && isRecord(value['tires']),
);

const carsSchema = object({ cars: array(carSchema) });
const plansSchema = custom<{
	maintenancePlans?: MaintenancePlan[];
	plans?: MaintenancePlan[];
	activity?: MaintenanceActivity[];
}>((value) => isRecord(value));
const servicesSchema = custom<{ serviceRecords?: ServiceRecord[] }>((value) =>
	isRecord(value),
);
const consumablesSchema = custom<{
	consumableMaintenance?: ConsumableEntry[];
}>((value) => isRecord(value));
const timezoneSchema = custom<{ timezone?: string }>((value) =>
	isRecord(value),
);
const reportResponseSchema = object({ report: reportSchema });
const planMutationSchema = object({ maintenancePlan: planSchema });
const serviceMutationSchema = object({ serviceRecord: serviceSchema });
const consumableMutationSchema = object({
	consumableMaintenance: consumableSchema,
});
const componentsSchema = object({ components: array(componentSchema) });
const setupSchema = custom<{
	setup?: { tires?: Record<string, unknown> | null };
	setups?: Array<{
		current?: boolean;
		tires?: Record<string, unknown> | null;
	}>;
}>((value) => isRecord(value));

const parse = <T>(
	result: { success: true; data: T } | { success: false },
): T => {
	if (!result.success) throw new InvalidMaintenanceResponse();
	return result.data;
};

const validTimezone = (value: unknown): value is string => {
	if (typeof value !== 'string' || !value.trim()) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
};

export const resolveMaintenanceBrowserTimezone = (
	resolve: () => string = () =>
		Intl.DateTimeFormat().resolvedOptions().timeZone,
): string => {
	try {
		const timezone = resolve();
		return validTimezone(timezone) ? timezone : 'UTC';
	} catch {
		return 'UTC';
	}
};

export const maintenanceGatewayFailure = (
	error: unknown,
): MaintenanceGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidMaintenanceResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

const parseCars = (value: unknown): MaintenanceCar[] =>
	parse(carsSchema.safeParse(value)).cars;

export const parseMaintenanceTimezone = (value: unknown): string => {
	const timezone = parse(timezoneSchema.safeParse(value)).timezone;
	return validTimezone(timezone)
		? timezone
		: resolveMaintenanceBrowserTimezone();
};

const parsePlans = (
	value: unknown,
): { plans: MaintenancePlan[]; activity: MaintenanceActivity[] } => {
	const response = parse(plansSchema.safeParse(value));
	const plans = response.maintenancePlans ?? response.plans ?? [];
	const activity = response.activity ?? [];
	if (
		!array(planSchema).safeParse(plans).success ||
		!array(activitySchema).safeParse(activity).success
	)
		throw new InvalidMaintenanceResponse();
	return { plans, activity };
};

const parseServices = (value: unknown): ServiceRecord[] => {
	const records = parse(servicesSchema.safeParse(value)).serviceRecords ?? [];
	return parse(array(serviceSchema).safeParse(records));
};

const parseConsumables = (value: unknown): ConsumableEntry[] => {
	const entries =
		parse(consumablesSchema.safeParse(value)).consumableMaintenance ?? [];
	return parse(array(consumableSchema).safeParse(entries));
};

const parseReport = (value: unknown): MaintenanceReport =>
	parse(reportResponseSchema.safeParse(value)).report;

const mapFailure = (error: unknown): Observable<never> =>
	throwError(() => maintenanceGatewayFailure(error));

@Injectable()
export class MaintenanceGateway {
	private readonly http = inject(HttpClient);

	readonly cars = httpResource<MaintenanceCar[]>(
		() => ({
			url: '/api/v1/cars',
			withCredentials: true,
			params: { archived: 'all' },
		}),
		{ parse: parseCars },
	);
	readonly timezone = httpResource<string>(
		() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		}),
		{ parse: parseMaintenanceTimezone },
	);
	readonly plans = httpResource<{
		plans: MaintenancePlan[];
		activity: MaintenanceActivity[];
	}>(() => ({ url: '/api/v1/maintenance-plans', withCredentials: true }), {
		parse: parsePlans,
	});
	readonly services = httpResource<ServiceRecord[]>(
		() => ({ url: '/api/v1/service-records', withCredentials: true }),
		{ parse: parseServices },
	);
	readonly consumables = httpResource<ConsumableEntry[]>(
		() => ({ url: '/api/v1/consumable-maintenance', withCredentials: true }),
		{ parse: parseConsumables },
	);
	readonly report = httpResource<MaintenanceReport>(
		() => ({ url: '/api/v1/consumables/report', withCredentials: true }),
		{ parse: parseReport },
	);

	savePlan(
		mode: 'create' | 'edit',
		id: string | null,
		plan: MaintenancePlanDraft,
	): Observable<MaintenancePlan> {
		const request =
			mode === 'edit' && id
				? this.http.patch<unknown>(
						`/api/v1/maintenance-plans/${encodeURIComponent(id)}`,
						plan,
						{ withCredentials: true },
					)
				: this.http.post<unknown>('/api/v1/maintenance-plans', plan, {
						withCredentials: true,
					});
		return request.pipe(
			map(
				(value) => parse(planMutationSchema.safeParse(value)).maintenancePlan,
			),
			catchError(mapFailure),
		);
	}

	transitionPlan(
		planId: string,
		action: 'pause' | 'resume' | 'archive',
	): Observable<MaintenancePlan> {
		return this.http
			.post<unknown>(
				`/api/v1/maintenance-plans/${encodeURIComponent(planId)}/${action}`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map(
					(value) => parse(planMutationSchema.safeParse(value)).maintenancePlan,
				),
				catchError(mapFailure),
			);
	}

	saveService(
		mode: 'create' | 'edit' | 'complete',
		carId: string,
		id: string | null,
		service: ServiceRecordDraft,
	): Observable<ServiceRecord> {
		const request =
			mode === 'edit' && id
				? this.http.patch<unknown>(
						`/api/v1/service-records/${encodeURIComponent(id)}`,
						service,
						{ withCredentials: true },
					)
				: mode === 'complete' && id
					? this.http.post<unknown>(
							`/api/v1/maintenance-plans/${encodeURIComponent(id)}/complete`,
							service,
							{ withCredentials: true },
						)
					: this.http.post<unknown>(
							`/api/v1/cars/${encodeURIComponent(carId)}/service-records`,
							service,
							{ withCredentials: true },
						);
		return request.pipe(
			map(
				(value) => parse(serviceMutationSchema.safeParse(value)).serviceRecord,
			),
			catchError(mapFailure),
		);
	}

	changeService(
		recordId: string,
		action: 'archive' | 'restore',
	): Observable<ServiceRecord> {
		const endpoint = `/api/v1/service-records/${encodeURIComponent(recordId)}`;
		const request =
			action === 'archive'
				? this.http.delete<unknown>(endpoint, { withCredentials: true })
				: this.http.post<unknown>(
						`${endpoint}/restore`,
						{},
						{ withCredentials: true },
					);
		return request.pipe(
			map(
				(value) => parse(serviceMutationSchema.safeParse(value)).serviceRecord,
			),
			catchError(mapFailure),
		);
	}

	components(carId: string): Observable<MaintenanceComponent[]> {
		return this.http
			.get<unknown>(`/api/v1/cars/${encodeURIComponent(carId)}/components`, {
				withCredentials: true,
			})
			.pipe(
				map((value) =>
					parse(componentsSchema.safeParse(value)).components.filter(
						(component) => !component.removedAt,
					),
				),
				catchError(mapFailure),
			);
	}

	saveConsumable(
		mode: 'create' | 'edit',
		carId: string,
		id: string | null,
		maintenance: ConsumableMaintenanceDraft,
	): Observable<ConsumableEntry> {
		const collection = `/api/v1/cars/${encodeURIComponent(carId)}/consumable-maintenance`;
		const request =
			mode === 'edit' && id
				? this.http.patch<unknown>(
						`${collection}/${encodeURIComponent(id)}`,
						maintenance,
						{ withCredentials: true },
					)
				: this.http.post<unknown>(collection, maintenance, {
						withCredentials: true,
					});
		return request.pipe(
			map(
				(value) =>
					parse(consumableMutationSchema.safeParse(value))
						.consumableMaintenance,
			),
			catchError(mapFailure),
		);
	}

	changeConsumable(
		entry: ConsumableEntry,
		action: 'archive' | 'restore',
	): Observable<ConsumableEntry> {
		const endpoint = `/api/v1/cars/${encodeURIComponent(entry.carId)}/consumable-maintenance/${encodeURIComponent(entry.id)}`;
		const request =
			action === 'archive'
				? this.http.delete<unknown>(endpoint, { withCredentials: true })
				: this.http.post<unknown>(
						`${endpoint}/restore`,
						{},
						{ withCredentials: true },
					);
		return request.pipe(
			map(
				(value) =>
					parse(consumableMutationSchema.safeParse(value))
						.consumableMaintenance,
			),
			catchError(mapFailure),
		);
	}

	currentTires(carId: string): Observable<Record<string, unknown> | null> {
		return this.http
			.get<unknown>(
				`/api/v1/cars/${encodeURIComponent(carId)}/setups/current`,
				{ withCredentials: true },
			)
			.pipe(
				map((value) => {
					const response = parse(setupSchema.safeParse(value));
					const setup =
						response.setup ??
						response.setups?.find((item) => item.current) ??
						response.setups?.[0];
					return setup?.tires ?? null;
				}),
				catchError(mapFailure),
			);
	}

	failure(error: unknown): MaintenanceGatewayFailure | null {
		return error ? maintenanceGatewayFailure(error) : null;
	}
}
