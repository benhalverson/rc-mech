import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type CurrentSetupGatewayFailure,
	CurrentSetupGateway,
} from './current-setup-gateway';
import type {
	CurrentSetupCollection,
	CurrentSetupSnapshot,
} from './current-setup.models';
import { CurrentSetupStore } from './current-setup-store';

const snapshot = (
	overrides: Partial<CurrentSetupSnapshot> = {},
): CurrentSetupSnapshot => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Current setup',
	current: true,
	context: {},
	sections: {
		vehicle: { rideHeight: '12 mm', weight: '1500 g' },
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	copiedFromSetupId: null,
	...overrides,
});

class FakeCurrentSetupGateway {
	private readonly collectionValue = signal<CurrentSetupCollection | undefined>(
		undefined,
	);
	private readonly loading = signal(false);
	private readonly readFailure = signal<CurrentSetupGatewayFailure | null>(
		null,
	);
	readonly collection = {
		hasValue: () => this.collectionValue() !== undefined,
		value: () => this.collectionValue() ?? { currentSetupId: null, setups: [] },
		isLoading: this.loading,
	};
	readonly failure = vi.fn(() => this.readFailure());
	readonly refresh = vi.fn();

	setCollection(value: CurrentSetupCollection | undefined): void {
		this.collectionValue.set(value);
	}

	setLoading(value: boolean): void {
		this.loading.set(value);
	}

	setFailure(value: CurrentSetupGatewayFailure | null): void {
		this.readFailure.set(value);
	}
}

describe('CurrentSetupStore', () => {
	let gateway: FakeCurrentSetupGateway;
	let store: InstanceType<typeof CurrentSetupStore>;

	beforeEach(() => {
		gateway = new FakeCurrentSetupGateway();
		TestBed.configureTestingModule({
			providers: [
				CurrentSetupStore,
				{ provide: CurrentSetupGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(CurrentSetupStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes empty, loading, selected-current, and fallback-current state', () => {
		expect(store.setups()).toEqual([]);
		expect(store.current()).toBeNull();
		expect(store.priorityRows()).toEqual([]);
		expect(store.remainingRows()).toEqual([]);
		expect(store.changes()).toEqual([]);

		gateway.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.setLoading(false);
		const selected = snapshot({ id: 'selected', current: false });
		const marked = snapshot({ id: 'marked', current: true });
		gateway.setCollection({
			currentSetupId: selected.id,
			setups: [marked, selected],
		});
		expect(store.current()?.id).toBe('selected');
		expect(store.setups()).toHaveLength(2);
		expect(store.priorityRows()[0]?.value).toBe('12 mm');
		expect(store.remainingRows()[0]?.value).toBe('1500 g');

		gateway.setCollection({ currentSetupId: 'missing', setups: [marked] });
		expect(store.current()?.id).toBe('marked');
		gateway.setCollection({
			currentSetupId: null,
			setups: [snapshot({ current: false })],
		});
		expect(store.current()).toBeNull();
	});

	it('derives changes from the copied setup and retries reads', () => {
		const previous = snapshot({
			id: 'previous',
			current: false,
			sections: {
				...snapshot().sections,
				vehicle: { rideHeight: '12 mm' },
			},
		});
		const current = snapshot({
			id: 'current',
			copiedFromSetupId: previous.id,
			sections: {
				...snapshot().sections,
				vehicle: { rideHeight: '14 mm' },
			},
		});
		gateway.setCollection({
			currentSetupId: current.id,
			setups: [current, previous],
		});
		expect(store.changes()).toContainEqual(
			expect.objectContaining({
				previousValue: '12 mm',
				currentValue: '14 mm',
			}),
		);
		store.retry();
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});

	it('maps authenticated, missing, invalid, and unavailable read failures', () => {
		expect(store.failure()).toBeNull();
		gateway.setFailure({ kind: 'http', status: 401 });
		expect(store.failure()).toEqual({
			message: 'Your garage session has expired. Sign in again to continue.',
			retryable: false,
		});
		gateway.setFailure({ kind: 'http', status: 404 });
		expect(store.failure()).toEqual({
			message: 'The current setup is unavailable for this car.',
			retryable: false,
		});
		gateway.setFailure({ kind: 'http', status: 503 });
		expect(store.failure()).toMatchObject({ retryable: true });
		gateway.setFailure({ kind: 'invalid-response' });
		expect(store.failure()?.message).toContain('could not be loaded');
		gateway.setFailure({ kind: 'unavailable' });
		expect(store.failure()?.retryable).toBe(true);
	});
});
