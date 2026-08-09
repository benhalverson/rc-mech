import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type ShellCar,
	type ShellCarCollection,
	ShellCarGateway,
} from './shell-car-gateway';
import { ShellCarStore } from './shell-car-store';
import {
	type CarWorkspaceSection,
	ShellRouteContext,
} from './shell-route-context';

class FakeShellCarGateway {
	private readonly value = signal<ShellCarCollection | undefined>(undefined);
	private readonly loading = signal(false);
	private readonly failure = signal<unknown>(undefined);
	readonly collection = {
		hasValue: () => this.value() !== undefined,
		value: () => this.value() ?? { cars: [] },
		isLoading: this.loading,
		error: this.failure,
	};
	readonly refresh = vi.fn();

	setCars(cars: ShellCar[]): void {
		this.value.set({ cars });
	}

	setLoading(value: boolean): void {
		this.loading.set(value);
	}

	setError(error: unknown): void {
		this.failure.set(error);
	}
}

describe('ShellCarStore', () => {
	const carId = signal<string | null>(null);
	const section = signal<CarWorkspaceSection | null>(null);
	let gateway: FakeShellCarGateway;
	let store: InstanceType<typeof ShellCarStore>;

	beforeEach(() => {
		carId.set(null);
		section.set(null);
		gateway = new FakeShellCarGateway();
		TestBed.configureTestingModule({
			providers: [
				ShellCarStore,
				{ provide: ShellCarGateway, useValue: gateway },
				{ provide: ShellRouteContext, useValue: { carId, section } },
			],
		});
		store = TestBed.inject(ShellCarStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('keeps remote state dormant outside a car workspace', () => {
		gateway.setLoading(true);
		gateway.setError(new Error('offline'));
		expect(store.cars()).toEqual([]);
		expect(store.currentCar()).toBeNull();
		expect(store.inCarWorkspace()).toBe(false);
		expect(store.loading()).toBe(false);
		expect(store.error()).toBe('');
		expect(store.carId()).toBeNull();
		expect(store.section()).toBeNull();
	});

	it('publishes current-car, loading, failure, and retry state', () => {
		carId.set('car-2');
		section.set('build');
		gateway.setLoading(true);
		expect(store.inCarWorkspace()).toBe(true);
		expect(store.loading()).toBe(true);

		gateway.setCars([
			{ id: 'car-1', name: 'Buggy', archivedAt: null },
			{ id: 'car-2', name: 'Truck', archivedAt: '2026-01-01' },
		]);
		gateway.setLoading(false);
		expect(store.cars()).toHaveLength(2);
		expect(store.currentCar()).toEqual({
			id: 'car-2',
			name: 'Truck',
			archivedAt: '2026-01-01',
		});
		expect(store.section()).toBe('build');

		carId.set('missing');
		expect(store.currentCar()).toBeNull();
		gateway.setError(new Error('offline'));
		expect(store.error()).toContain('could not be loaded');

		store.retry();
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});
});
