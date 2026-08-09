import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ConsumableEntry,
	MaintenanceGatewayFailure,
	MaintenanceReport,
} from '../maintenance.models';
import { MaintenanceGateway } from '../maintenance-gateway';
import { ConsumableStore } from './consumable-store';

const entry = (overrides: Partial<ConsumableEntry> = {}): ConsumableEntry => ({
	id: 'entry-1',
	carId: 'car-1',
	kind: 'shock-fluid',
	performedAt: '2026-08-09T18:00:00.000Z',
	...overrides,
});

const report: MaintenanceReport = {
	tires: {
		frequency: {
			front: { eventCount: 0, averageIntervalDays: null },
			rear: { eventCount: 0, averageIntervalDays: null },
		},
		spend: {
			front: { total: 0 },
			rear: { total: 0 },
			combined: { total: 0 },
		},
	},
	fluidHistory: [],
};

const resource = <T>() => {
	const value = signal<T | undefined>(undefined);
	const loading = signal(false);
	const error = signal<MaintenanceGatewayFailure | null>(null);
	return {
		hasValue: () => value() !== undefined,
		value: () => value() as T,
		isLoading: loading,
		error,
		reload: vi.fn(),
		setValue(next: T | undefined): void {
			value.set(next);
		},
		setLoading(next: boolean): void {
			loading.set(next);
		},
		setError(next: MaintenanceGatewayFailure | null): void {
			error.set(next);
		},
	};
};

class FakeMaintenanceGateway {
	readonly cars = resource<Array<{ id: string; name: string }>>();
	readonly timezone = resource<string>();
	readonly consumables = resource<ConsumableEntry[]>();
	readonly report = resource<MaintenanceReport>();
	private saveResult = new Subject<ConsumableEntry>();
	private changeResult = new Subject<ConsumableEntry>();
	private readonly tireResults = new Map<
		string,
		Subject<Record<string, unknown> | null>
	>();

	readonly failure = vi.fn((failure: unknown) =>
		failure ? (failure as MaintenanceGatewayFailure) : null,
	);
	readonly saveConsumable = vi.fn(
		(
			_mode: 'create' | 'edit',
			_carId: string,
			_id: string | null,
			_maintenance: Readonly<Record<string, unknown>>,
		): Observable<ConsumableEntry> => this.saveResult.asObservable(),
	);
	readonly changeConsumable = vi.fn(
		(
			_entry: ConsumableEntry,
			_action: 'archive' | 'restore',
		): Observable<ConsumableEntry> => this.changeResult.asObservable(),
	);
	readonly currentTires = vi.fn(
		(carId: string): Observable<Record<string, unknown> | null> => {
			const result = new Subject<Record<string, unknown> | null>();
			this.tireResults.set(carId, result);
			return result.asObservable();
		},
	);

	resetSave(): void {
		this.saveResult = new Subject<ConsumableEntry>();
	}

	resetChange(): void {
		this.changeResult = new Subject<ConsumableEntry>();
	}

	succeedSave(value: ConsumableEntry): void {
		this.saveResult.next(value);
		this.saveResult.complete();
	}

	failSave(failure: MaintenanceGatewayFailure): void {
		this.saveResult.error(failure);
	}

	succeedChange(value: ConsumableEntry): void {
		this.changeResult.next(value);
		this.changeResult.complete();
	}

	failChange(failure: MaintenanceGatewayFailure): void {
		this.changeResult.error(failure);
	}

	succeedTires(carId: string, tires: Record<string, unknown> | null): void {
		this.tireResults.get(carId)?.next(tires);
		this.tireResults.get(carId)?.complete();
	}

	failTires(carId: string): void {
		this.tireResults.get(carId)?.error({ kind: 'unavailable' });
	}
}

describe('ConsumableStore', () => {
	let gateway: FakeMaintenanceGateway;
	let store: InstanceType<typeof ConsumableStore>;

	beforeEach(() => {
		gateway = new FakeMaintenanceGateway();
		TestBed.configureTestingModule({
			providers: [
				ConsumableStore,
				{ provide: MaintenanceGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(ConsumableStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes defaults, resources, loading, and both read failure messages', () => {
		expect(store.cars()).toEqual([]);
		expect(store.timezone()).toBe('UTC');
		expect(store.entries()).toEqual([]);
		expect(store.report()).toBeNull();
		expect(store.loading()).toBe(false);
		expect(store.error()).toBe('');
		expect(store.action()).toBeNull();
		gateway.cars.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.cars.setLoading(false);
		gateway.timezone.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.timezone.setLoading(false);
		gateway.consumables.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.consumables.setLoading(false);

		gateway.cars.setValue([{ id: 'car-1', name: 'Red Runner' }]);
		gateway.timezone.setValue('America/Los_Angeles');
		gateway.consumables.setValue([entry()]);
		gateway.report.setValue(report);
		expect(store.cars()).toHaveLength(1);
		expect(store.timezone()).toBe('America/Los_Angeles');
		expect(store.entries()).toEqual([entry()]);
		expect(store.report()).toEqual(report);

		gateway.cars.setLoading(true);
		expect(store.loading()).toBe(false);
		gateway.cars.setLoading(false);
		gateway.consumables.setLoading(true);
		expect(store.action()).toBe('refresh');
		gateway.consumables.setLoading(false);
		gateway.report.setLoading(true);
		expect(store.action()).toBe('refresh');
		gateway.report.setLoading(false);
		expect(store.action()).toBeNull();
		gateway.cars.setError({ kind: 'http', status: 401 });
		expect(store.error()).toContain('session has expired');
		gateway.cars.setError(null);
		gateway.consumables.setError({ kind: 'unavailable' });
		expect(store.error()).toContain('could not be loaded');
	});

	it('retries every read and serializes successful save commands', () => {
		store.retry();
		for (const boundary of [
			gateway.cars,
			gateway.timezone,
			gateway.consumables,
			gateway.report,
		])
			expect(boundary.reload).toHaveBeenCalledOnce();

		store.mutate({
			kind: 'save',
			mode: 'create',
			carId: 'car-1',
			id: null,
			maintenance: {
				kind: 'shock-fluid',
				performedAt: '2026-08-09T18:00:00.000Z',
				fluidArea: 'front-shocks',
			},
		});
		expect(store.action()).toBe('create');
		store.mutate({
			kind: 'save',
			mode: 'edit',
			carId: 'car-1',
			id: 'entry-1',
			maintenance: {
				kind: 'shock-fluid',
				performedAt: '2026-08-09T18:00:00.000Z',
				fluidArea: 'front-shocks',
			},
		});
		expect(gateway.saveConsumable).toHaveBeenCalledOnce();
		gateway.succeedSave(entry());
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
		});
		expect(gateway.consumables.reload).toHaveBeenCalledTimes(2);
		expect(gateway.report.reload).toHaveBeenCalledTimes(2);
		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('runs archive and restore commands and maps mutation failures', () => {
		const current = entry();
		store.mutate({ kind: 'change', action: 'archive', entry: current });
		expect(store.action()).toBe('archive:entry-1');
		gateway.failChange({ kind: 'unavailable' });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			failure: 'archive-failed',
		});

		gateway.resetChange();
		store.mutate({ kind: 'change', action: 'archive', entry: current });
		gateway.succeedChange({ ...current, deletedAt: '2026-08-09' });
		expect(store.outcome().status).toBe('succeeded');

		gateway.resetChange();
		store.mutate({
			kind: 'change',
			action: 'restore',
			entry: { ...current, deletedAt: '2026-08-09' },
		});
		expect(store.action()).toBe('restore:entry-1');
		gateway.failChange({ kind: 'http', status: 409 });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			failure: 'restore-failed',
		});

		gateway.resetSave();
		store.mutate({
			kind: 'save',
			mode: 'edit',
			carId: 'car-1',
			id: 'entry-1',
			maintenance: {
				kind: 'shock-fluid',
				performedAt: '2026-08-09T18:00:00.000Z',
				fluidArea: 'front-shocks',
			},
		});
		gateway.failSave({ kind: 'http', status: 409 });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			failure: 'car-archived',
		});

		gateway.resetSave();
		store.mutate({
			kind: 'save',
			mode: 'create',
			carId: 'car-1',
			id: null,
			maintenance: {
				kind: 'shock-fluid',
				performedAt: '2026-08-09T18:00:00.000Z',
				fluidArea: 'front-shocks',
			},
		});
		gateway.failSave({ kind: 'unavailable' });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			failure: 'save-failed',
		});
	});

	it('keeps only the latest tire lookup and publishes success and failure', () => {
		store.loadTires('');
		expect(gateway.currentTires).not.toHaveBeenCalled();
		store.loadTires('car-1');
		expect(store.tireLookup()).toEqual({ status: 'pending', carId: 'car-1' });
		store.loadTires('car-2');
		gateway.succeedTires('car-1', { front: 'Stale' });
		expect(store.tireLookup()).toEqual({ status: 'pending', carId: 'car-2' });
		gateway.succeedTires('car-2', { front: 'Current' });
		expect(store.tireLookup()).toEqual({
			status: 'succeeded',
			carId: 'car-2',
			tires: { front: 'Current' },
		});

		store.loadTires('car-3');
		gateway.failTires('car-3');
		expect(store.tireLookup()).toEqual({ status: 'failed', carId: 'car-3' });
	});
});
