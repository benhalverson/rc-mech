import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CurrentSetupCollection,
	CurrentSetupSnapshot,
	SaveCurrentSetupCommand,
} from './current-setup.models';
import {
	CurrentSetupGateway,
	type CurrentSetupGatewayFailure,
} from './current-setup-gateway';
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
	updatedAt: '2026-08-09T21:00:00.000Z',
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
	private readonly timezoneValue = signal<
		{ timezone: string | null } | undefined
	>(undefined);
	private readonly timezoneLoading = signal(true);
	private saveMutation = new Subject<CurrentSetupSnapshot>();
	readonly collection = {
		hasValue: () => this.collectionValue() !== undefined,
		value: () => this.collectionValue() ?? { currentSetupId: null, setups: [] },
		isLoading: this.loading,
	};
	readonly timezone = {
		hasValue: () => this.timezoneValue() !== undefined,
		value: () => this.timezoneValue() ?? { timezone: null },
		isLoading: this.timezoneLoading,
	};
	readonly failure = vi.fn(() => this.readFailure());
	readonly refresh = vi.fn();
	readonly saveCurrentSetup = vi.fn(
		(_command: SaveCurrentSetupCommand): Observable<CurrentSetupSnapshot> =>
			this.saveMutation.asObservable(),
	);

	setCollection(value: CurrentSetupCollection | undefined): void {
		this.collectionValue.set(value);
	}

	setLoading(value: boolean): void {
		this.loading.set(value);
	}

	setFailure(value: CurrentSetupGatewayFailure | null): void {
		this.readFailure.set(value);
	}

	setTimezone(value: string | null): void {
		this.timezoneValue.set({ timezone: value });
		this.timezoneLoading.set(false);
	}

	finishTimezoneWithoutValue(): void {
		this.timezoneLoading.set(false);
	}

	succeedSave(value: CurrentSetupSnapshot): void {
		this.saveMutation.next(value);
		this.saveMutation.complete();
	}

	failSave(failure: CurrentSetupGatewayFailure): void {
		this.saveMutation.error(failure);
	}

	resetSave(): void {
		this.saveMutation = new Subject<CurrentSetupSnapshot>();
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

	const command = (
		overrides: Partial<SaveCurrentSetupCommand> = {},
	): SaveCurrentSetupCommand => ({
		carId: 'car-1',
		sourceSetupId: 'setup-1',
		sourceUpdatedAt: '2026-08-09T21:00:00.000Z',
		draft: {
			name: 'Current setup · Aug 9, 3:15 AM',
			recordedAt: '2026-08-09T00:00:00.000Z',
			track: null,
			event: null,
			surface: null,
			traction: null,
			moisture: null,
			condition: null,
			temperature: null,
			sections: snapshot().sections,
		},
		...overrides,
	});

	it('publishes empty, loading, selected-current, and fallback-current state', () => {
		expect(store.setups()).toEqual([]);
		expect(store.current()).toBeNull();
		expect(store.priorityRows()).toEqual([]);
		expect(store.remainingRows()).toEqual([]);
		expect(store.changes()).toEqual([]);
		expect(store.outcome()).toEqual({
			status: 'idle',
			operation: 'save-current-setup',
			operationId: null,
		});
		expect(store.timezone()).toBeTruthy();
		expect(store.timezoneReady()).toBe(false);
		gateway.finishTimezoneWithoutValue();
		expect(store.timezoneReady()).toBe(true);
		store.selectCar('car-1');
		store.selectCar('car-1');
		gateway.setTimezone('America/Los_Angeles');
		expect(store.timezone()).toBe('America/Los_Angeles');
		expect(store.timezoneReady()).toBe(true);
		gateway.setTimezone('Not/A-Timezone');
		expect(store.timezone()).toBeTruthy();

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
		gateway.setLoading(true);
		expect(store.loading()).toBe(false);
		gateway.setLoading(false);

		gateway.setCollection({ currentSetupId: 'missing', setups: [marked] });
		expect(store.current()?.id).toBe('marked');
		gateway.setCollection({
			currentSetupId: null,
			setups: [snapshot({ current: false })],
		});
		expect(store.current()).toBeNull();
	});

	it('derives changes from the copied setup and retries reads', () => {
		store.selectCar('car-1');
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

	it('suppresses duplicate saves and publishes the new Current setup', () => {
		const source = snapshot();
		gateway.setCollection({ currentSetupId: source.id, setups: [source] });
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		expect(store.pending()).toBe(true);
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'save-current-setup',
			operationId: 1,
		});
		store.saveCurrentSetup(command({ sourceSetupId: 'duplicate' }));
		expect(gateway.saveCurrentSetup).toHaveBeenCalledOnce();
		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('pending');

		const saved = snapshot({
			id: 'setup-2',
			name: 'Current setup · Aug 9, 3:15 AM',
			copiedFromSetupId: source.id,
		});
		gateway.succeedSave(saved);
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
			setup: { id: 'setup-2' },
		});
		expect(store.current()?.id).toBe('setup-2');
		expect(store.setups()).toEqual([
			saved,
			expect.objectContaining({ id: 'setup-1', current: false }),
		]);
		expect(store.saveError()).toBe('');
		expect(gateway.refresh).toHaveBeenCalledOnce();
		gateway.setFailure({ kind: 'unavailable' });
		expect(store.failure()).toBeNull();
		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('idle');
	});

	it('validates commands, rejects stale sources, and maps save failures', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.selectCar('car-1');
		store.saveCurrentSetup(
			command({ draft: { ...command().draft, name: '   ' } }),
		);
		expect(store.saveError()).toContain('Name this setup');
		expect(gateway.saveCurrentSetup).not.toHaveBeenCalled();

		store.saveCurrentSetup(command({ sourceSetupId: 'stale' }));
		expect(store.saveError()).toContain('changed while you were editing');
		expect(store.outcome()).toMatchObject({ operationId: 2 });
		store.saveCurrentSetup(command({ sourceUpdatedAt: '' }));
		expect(store.saveError()).toContain('changed while you were editing');

		store.saveCurrentSetup(
			command({ sourceUpdatedAt: '2026-08-09T21:00:01.000Z' }),
		);
		expect(store.saveError()).toContain('changed while you were editing');

		gateway.resetSave();
		store.saveCurrentSetup(command());
		gateway.failSave({
			kind: 'rejected-response',
			status: 422,
			message: 'That setup value is unavailable.',
		});
		expect(store.saveError()).toBe('That setup value is unavailable.');

		gateway.resetSave();
		store.saveCurrentSetup(command());
		gateway.failSave({ kind: 'http', status: 401 });
		expect(store.saveError()).toContain('session has expired');

		gateway.resetSave();
		store.saveCurrentSetup(command());
		gateway.failSave({ kind: 'http', status: 409 });
		expect(store.saveError()).toContain('Restore this car');

		gateway.resetSave();
		store.saveCurrentSetup(command());
		gateway.failSave({ kind: 'unavailable' });
		expect(store.saveError()).toContain('could not be saved');
	});

	it('cancels stale route mutations and ignores commands for another car', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.saveCurrentSetup(command());
		expect(gateway.saveCurrentSetup).not.toHaveBeenCalled();
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		store.selectCar('car-2');
		expect(store.outcome().status).toBe('idle');
		gateway.succeedSave(snapshot({ id: 'stale-save' }));
		expect(store.current()).toBeNull();
		expect(store.setups()).toEqual([]);
		expect(gateway.refresh).not.toHaveBeenCalled();

		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('idle');
	});

	it('guards both success and failure with the captured route generation', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.succeedSave(snapshot({ id: 'stale-success' }));
		expect(store.outcome().status).toBe('pending');
		expect(gateway.refresh).not.toHaveBeenCalled();

		gateway.resetSave();
		store.saveCurrentSetup(command());
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.failSave({ kind: 'unavailable' });
		expect(store.outcome().status).toBe('pending');
		expect(gateway.refresh).not.toHaveBeenCalled();
	});
});
