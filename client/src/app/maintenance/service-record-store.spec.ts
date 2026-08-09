import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceActivity,
	MaintenanceCar,
	MaintenanceComponent,
	MaintenanceGatewayFailure,
	MaintenancePlan,
	ServiceRecord,
	ServiceRecordDraft,
} from './maintenance.models';
import { MaintenanceGateway } from './maintenance-gateway';
import { ServiceRecordStore } from './service-record-store';

class FakeResource<T> {
	private readonly current = signal<T | undefined>(undefined);
	readonly isLoading = signal(false);
	readonly error = signal<MaintenanceGatewayFailure | null>(null);
	readonly reload = vi.fn();

	hasValue(): boolean {
		return this.current() !== undefined;
	}

	value(): T {
		const value = this.current();
		if (value === undefined) throw new Error('No fake resource value.');
		return value;
	}

	set(value: T | undefined): void {
		this.current.set(value);
	}
}

const car: MaintenanceCar = {
	id: 'car-1',
	name: 'Red Runner',
	archivedAt: null,
};
const record: ServiceRecord = {
	id: 'record-1',
	carId: 'car-1',
	planId: 'plan-1',
	performedAt: '2026-08-01T00:00:00.000Z',
	description: 'Scheduled work',
};
const component: MaintenanceComponent = {
	id: 'component-1',
	carId: 'car-1',
	slot: 'motor',
	name: 'Motor',
};
const draft: ServiceRecordDraft = {
	performedAt: '2026-08-09T18:00:00.000Z',
	description: 'Cleaned',
};
const activity: MaintenanceActivity = {
	id: 'activity-1',
	action: 'Server activity',
	occurredAt: '2026-08-01T00:00:00.000Z',
};

class FakeServiceGateway {
	readonly cars = new FakeResource<MaintenanceCar[]>();
	readonly timezone = new FakeResource<string>();
	readonly plans = new FakeResource<{
		plans: MaintenancePlan[];
		activity: MaintenanceActivity[];
	}>();
	readonly services = new FakeResource<ServiceRecord[]>();
	readonly saveService = vi.fn(() => of(record));
	readonly changeService = vi.fn(() => of(record));
	readonly components = vi.fn(() => of([component]));
	readonly failure = vi.fn((value: MaintenanceGatewayFailure | null) => value);
}

describe('ServiceRecordStore', () => {
	let gateway: FakeServiceGateway;
	let store: InstanceType<typeof ServiceRecordStore>;

	beforeEach(() => {
		gateway = new FakeServiceGateway();
		TestBed.configureTestingModule({
			providers: [
				ServiceRecordStore,
				{ provide: MaintenanceGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(ServiceRecordStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('derives records, fallback activity, loading, and read failures', () => {
		expect(store.cars()).toEqual([]);
		expect(store.timezone()).toBe('UTC');
		expect(store.records()).toEqual([]);
		expect(store.activity()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.error()).toBe('');

		gateway.cars.set([car]);
		gateway.timezone.set('America/Los_Angeles');
		gateway.plans.set({ plans: [], activity: [] });
		gateway.services.isLoading.set(true);
		expect(store.loading()).toBe(true);
		gateway.services.set([
			record,
			{ ...record, id: 'ad-hoc', planId: null },
			{ ...record, id: 'deleted', deletedAt: '2026-08-02' },
		]);
		expect(store.loading()).toBe(false);
		expect(store.action()).toBe('refresh');
		gateway.services.isLoading.set(false);
		expect(store.cars()).toEqual([car]);
		expect(store.timezone()).toBe('America/Los_Angeles');
		expect(store.records()).toHaveLength(3);
		expect(store.activity().map((item) => item.action)).toEqual([
			'Scheduled service',
			'Ad hoc service',
		]);

		gateway.plans.set({ plans: [], activity: [activity] });
		expect(store.activity()).toEqual([activity]);
		gateway.services.error.set({ kind: 'http', status: 401 });
		expect(store.error()).toContain('session has expired');
		gateway.services.error.set({ kind: 'unavailable' });
		expect(store.error()).toContain('could not be loaded');
		gateway.services.error.set(null);
		expect(store.error()).toBe('');
	});

	it('retries and refreshes only service reads', () => {
		gateway.plans.isLoading.set(true);
		expect(store.action()).toBe('refresh');
		gateway.plans.isLoading.set(false);
		store.retry();
		expect(gateway.services.reload).toHaveBeenCalledOnce();
		gateway.services.reload.mockClear();
		store.refresh();
		expect(gateway.services.reload).toHaveBeenCalledOnce();
	});

	it('drops duplicate saves and runs every service command through the gateway', () => {
		const pending = new Subject<ServiceRecord>();
		gateway.saveService.mockReturnValueOnce(pending);
		store.mutate({
			kind: 'save-service',
			mode: 'create',
			carId: 'car/1',
			id: null,
			service: draft,
		});
		store.mutate({
			kind: 'save-service',
			mode: 'edit',
			carId: 'car/1',
			id: 'ignored',
			service: draft,
		});
		expect(gateway.saveService).toHaveBeenCalledOnce();
		expect(gateway.saveService).toHaveBeenCalledWith(
			'create',
			'car/1',
			null,
			draft,
		);
		expect(store.action()).toBe('create');
		pending.next(record);
		pending.complete();
		expect(gateway.services.reload).toHaveBeenCalledOnce();
		expect(gateway.plans.reload).toHaveBeenCalledOnce();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
		});

		store.mutate({
			kind: 'change-service',
			recordId: 'record-1',
			action: 'archive',
		});
		expect(gateway.changeService).toHaveBeenLastCalledWith(
			'record-1',
			'archive',
		);
		store.mutate({
			kind: 'change-service',
			recordId: 'record-1',
			action: 'restore',
		});
		expect(gateway.changeService).toHaveBeenLastCalledWith(
			'record-1',
			'restore',
		);
		store.mutate({ kind: 'undo-activity', recordId: 'record-1' });
		expect(gateway.changeService).toHaveBeenLastCalledWith(
			'record-1',
			'archive',
		);
		expect(store.action()).toBeNull();
		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('normalizes every service mutation failure and action label', () => {
		for (const [command, reason, action] of [
			[
				{ kind: 'undo-activity' as const, recordId: 'record-1' },
				'undo-failed',
				'undo:record-1',
			],
			[
				{
					kind: 'change-service' as const,
					recordId: 'record-1',
					action: 'archive' as const,
				},
				'archive-failed',
				'delete:record-1',
			],
			[
				{
					kind: 'change-service' as const,
					recordId: 'record-1',
					action: 'restore' as const,
				},
				'restore-failed',
				'restore:record-1',
			],
		] as const) {
			const pending = new Subject<ServiceRecord>();
			gateway.changeService.mockReturnValueOnce(pending);
			store.mutate(command);
			expect(store.action()).toBe(action);
			pending.error({ kind: 'unavailable' });
			expect(store.outcome()).toMatchObject({
				status: 'failed',
				failure: reason,
			});
		}

		for (const [failure, reason] of [
			[{ kind: 'http', status: 401 }, 'session-expired'],
			[{ kind: 'http', status: 409 }, 'car-archived'],
			[{ kind: 'unavailable' }, 'save-failed'],
		] as const) {
			gateway.saveService.mockReturnValueOnce(throwError(() => failure));
			store.mutate({
				kind: 'save-service',
				mode: 'complete',
				carId: 'car-1',
				id: 'plan-1',
				service: draft,
			});
			expect(store.outcome()).toMatchObject({
				status: 'failed',
				failure: reason,
			});
		}
	});

	it('switches component lookups and clears empty or failed selections', () => {
		const cancelled = vi.fn();
		gateway.components
			.mockReturnValueOnce(new Observable(() => cancelled))
			.mockReturnValueOnce(of([component]))
			.mockReturnValueOnce(
				throwError(() => ({ kind: 'unavailable' as const })),
			);
		store.loadComponents('car-1');
		store.loadComponents('car-2');
		expect(cancelled).toHaveBeenCalledOnce();
		expect(store.components()).toEqual([component]);
		store.loadComponents('');
		expect(store.components()).toEqual([]);
		store.loadComponents('car-3');
		expect(store.components()).toEqual([]);
	});
});
