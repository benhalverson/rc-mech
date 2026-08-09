import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	MaintenanceCar,
	MaintenanceComponent,
	MaintenanceGatewayFailure,
	MaintenancePlan,
	MaintenancePlanDraft,
} from './maintenance.models';
import { MaintenanceGateway } from './maintenance-gateway';
import { MaintenancePlanStore } from './maintenance-plan-store';

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
const plan: MaintenancePlan = {
	id: 'plan-1',
	carId: 'car-1',
	componentId: null,
	name: 'Inspect',
	status: 'active',
};
const component: MaintenanceComponent = {
	id: 'component-1',
	carId: 'car-1',
	slot: 'motor',
	name: 'Motor',
};
const draft: MaintenancePlanDraft = {
	carId: 'car-1',
	name: 'Inspect',
	intervalUnit: 'days',
	intervalValue: 7,
	baselineSessionCount: 0,
};

class FakePlanGateway {
	readonly cars = new FakeResource<MaintenanceCar[]>();
	readonly timezone = new FakeResource<string>();
	readonly plans = new FakeResource<{
		plans: MaintenancePlan[];
		activity: [];
	}>();
	readonly savePlan = vi.fn(() => of(plan));
	readonly transitionPlan = vi.fn(() => of(plan));
	readonly components = vi.fn(() => of([component]));
	readonly failure = vi.fn((value: MaintenanceGatewayFailure | null) => value);
}

describe('MaintenancePlanStore', () => {
	let gateway: FakePlanGateway;
	let store: InstanceType<typeof MaintenancePlanStore>;

	beforeEach(() => {
		gateway = new FakePlanGateway();
		TestBed.configureTestingModule({
			providers: [
				MaintenancePlanStore,
				{ provide: MaintenanceGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(MaintenancePlanStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('derives resource values, loading, and canonical read failures', () => {
		expect(store.cars()).toEqual([]);
		expect(store.timezone()).toBe('UTC');
		expect(store.plans()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.error()).toBe('');

		gateway.cars.isLoading.set(true);
		expect(store.loading()).toBe(true);
		gateway.cars.set([car]);
		expect(store.loading()).toBe(false);
		gateway.timezone.isLoading.set(true);
		expect(store.loading()).toBe(true);
		gateway.timezone.set('America/Los_Angeles');
		expect(store.loading()).toBe(false);
		gateway.plans.isLoading.set(true);
		expect(store.loading()).toBe(true);
		gateway.plans.set({ plans: [plan], activity: [] });
		expect(store.loading()).toBe(false);
		expect(store.action()).toBe('refresh');
		gateway.plans.isLoading.set(false);
		expect(store.cars()).toEqual([car]);
		expect(store.timezone()).toBe('America/Los_Angeles');
		expect(store.plans()).toEqual([plan]);

		gateway.timezone.error.set({ kind: 'http', status: 401 });
		expect(store.error()).toContain('session has expired');
		gateway.timezone.error.set(null);
		gateway.plans.error.set({ kind: 'unavailable' });
		expect(store.error()).toContain('could not be loaded');
		gateway.plans.error.set(null);
		expect(store.error()).toBe('');
	});

	it('retries and refreshes only its owned reads', () => {
		store.retry();
		expect(gateway.cars.reload).toHaveBeenCalledOnce();
		expect(gateway.timezone.reload).toHaveBeenCalledOnce();
		expect(gateway.plans.reload).toHaveBeenCalledOnce();
		gateway.plans.reload.mockClear();
		store.refresh();
		expect(gateway.plans.reload).toHaveBeenCalledOnce();
	});

	it('drops duplicate plan saves and publishes identified outcomes', () => {
		const pending = new Subject<MaintenancePlan>();
		gateway.savePlan.mockReturnValueOnce(pending);
		store.mutate({
			kind: 'save-plan',
			mode: 'create',
			id: null,
			plan: draft,
		});
		store.mutate({
			kind: 'save-plan',
			mode: 'edit',
			id: 'ignored',
			plan: draft,
		});
		expect(gateway.savePlan).toHaveBeenCalledOnce();
		expect(gateway.savePlan).toHaveBeenCalledWith('create', null, draft);
		expect(store.action()).toBe('create');
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operationId: 1,
		});

		pending.next(plan);
		pending.complete();
		expect(gateway.plans.reload).toHaveBeenCalledOnce();
		expect(store.action()).toBeNull();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
		});
		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });

		const transition = new Subject<MaintenancePlan>();
		gateway.transitionPlan.mockReturnValueOnce(transition);
		store.mutate({
			kind: 'transition-plan',
			planId: 'plan/1',
			action: 'pause',
		});
		expect(gateway.transitionPlan).toHaveBeenCalledWith('plan/1', 'pause');
		expect(store.action()).toBe('pause:plan/1');
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operationId: 2,
		});
		transition.next(plan);
		transition.complete();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 2,
		});
	});

	it('normalizes every plan mutation failure', () => {
		gateway.transitionPlan.mockReturnValueOnce(
			throwError(() => ({ kind: 'http', status: 500 })),
		);
		store.mutate({
			kind: 'transition-plan',
			planId: 'plan-1',
			action: 'archive',
		});
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			failure: 'transition-failed',
		});

		for (const [failure, reason] of [
			[{ kind: 'http', status: 401 }, 'session-expired'],
			[{ kind: 'http', status: 409 }, 'car-archived'],
			[{ kind: 'unavailable' }, 'save-failed'],
		] as const) {
			gateway.savePlan.mockReturnValueOnce(throwError(() => failure));
			store.mutate({
				kind: 'save-plan',
				mode: 'edit',
				id: 'plan-1',
				plan: draft,
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
