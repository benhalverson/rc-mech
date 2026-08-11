import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CarWorkspaceStore,
	type SetupWorkspaceMutationFailure,
	type SetupWorkspaceMutationOutcome,
} from '../../garage/car-sync/car-workspace-store';
import type { SetupSnapshot } from '../setups/setup-snapshot';
import type {
	SetupSyncCollection,
	SetupSyncCommand,
} from '../setups/setup-sync.models';
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

const syncedSnapshot = (
	overrides: Partial<SetupSnapshot> = {},
): SetupSnapshot => ({
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

class FakeWorkspace {
	readonly setupCollections = signal<readonly SetupSyncCollection[]>([]);
	readonly setupMutationOutcome = signal<SetupWorkspaceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly durableSetupMutationsAvailable = signal(true);
	readonly externalRequestsAvailable = signal(true);
	readonly acceptSetupCommits = signal(true);
	readonly setupMark = vi.fn(() => ({ kind: 'synced' }) as const);
	private requestId = 0;

	readonly observeServerSetupCollection = vi.fn(
		(collection: SetupSyncCollection) => {
			this.setupCollections.update((collections) => [
				...collections.filter((entry) => entry.carId !== collection.carId),
				collection,
			]);
		},
	);
	readonly clearSetupMutationState = vi.fn(() => {
		if (this.setupMutationOutcome().status !== 'pending')
			this.setupMutationOutcome.set({ status: 'idle', requestId: null });
	});
	readonly commitSetup = vi.fn((command: SetupSyncCommand) => {
		if (!this.acceptSetupCommits()) return;
		this.setupMutationOutcome.set({
			status: 'pending',
			requestId: ++this.requestId,
			command,
		});
	});

	succeed(setup: SetupSnapshot, retainedLocally = true): void {
		const pending = this.setupMutationOutcome();
		if (pending.status !== 'pending')
			throw new Error('No pending setup command.');
		const collection = this.setupCollections().find(
			(entry) => entry.carId === pending.command.carId,
		) ?? {
			carId: pending.command.carId,
			currentSetupId: null,
			currentSetupVersion: 0,
			setups: [],
		};
		this.setupCollections.set([
			...this.setupCollections().filter(
				(entry) => entry.carId !== pending.command.carId,
			),
			{
				...collection,
				currentSetupId: setup.id,
				currentSetupVersion: collection.currentSetupVersion + 1,
				setups: [
					setup,
					...collection.setups
						.filter((entry) => entry.id !== setup.id)
						.map((entry) => ({ ...entry, current: false })),
				],
			},
		]);
		this.setupMutationOutcome.set({
			status: 'succeeded',
			requestId: pending.requestId,
			operationId: `operation-${pending.requestId}`,
			command: pending.command,
			setup,
			retainedLocally,
		});
	}

	fail(error: SetupWorkspaceMutationFailure): void {
		const pending = this.setupMutationOutcome();
		if (pending.status !== 'pending')
			throw new Error('No pending setup command.');
		this.setupMutationOutcome.set({
			status: 'failed',
			requestId: pending.requestId,
			command: pending.command,
			error,
		});
	}
}

describe('CurrentSetupStore', () => {
	let gateway: FakeCurrentSetupGateway;
	let workspace: FakeWorkspace;
	let store: InstanceType<typeof CurrentSetupStore>;

	beforeEach(() => {
		gateway = new FakeCurrentSetupGateway();
		workspace = new FakeWorkspace();
		TestBed.configureTestingModule({
			providers: [
				CurrentSetupStore,
				{ provide: CurrentSetupGateway, useValue: gateway },
				{ provide: CarWorkspaceStore, useValue: workspace },
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
		TestBed.flushEffects();
		gateway.setLoading(false);

		gateway.setCollection({ currentSetupId: 'missing', setups: [marked] });
		expect(store.current()?.id).toBe('marked');
		gateway.setCollection({
			currentSetupId: null,
			setups: [
				snapshot({
					current: false,
					context: {},
					copiedFromSetupId: undefined,
					sections: {
						...snapshot().sections,
						vehicle: { numberValue: 2, emptyValue: null },
					},
				}),
			],
		});
		expect(store.current()).toBeNull();
		TestBed.flushEffects();
		expect(workspace.observeServerSetupCollection).toHaveBeenLastCalledWith(
			expect.objectContaining({
				setups: [
					expect.objectContaining({
						sections: expect.objectContaining({
							vehicle: { numberValue: '2', emptyValue: null },
						}),
					}),
				],
			}),
		);
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
		TestBed.flushEffects();
		store.saveCurrentSetup(command());
		expect(store.pending()).toBe(true);
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'save-current-setup',
			operationId: 1,
		});
		store.saveCurrentSetup(command({ sourceSetupId: 'duplicate' }));
		expect(workspace.commitSetup).toHaveBeenCalledOnce();
		expect(workspace.commitSetup).toHaveBeenCalledWith({
			type: 'change',
			carId: 'car-1',
			setupId: 'setup-1',
			draft: expect.objectContaining({
				name: 'Current setup · Aug 9, 3:15 AM',
				setupDate: '2026-08-09T00:00:00.000Z',
				status: 'active',
			}),
		});
		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('pending');

		const saved = syncedSnapshot({
			id: 'setup-2',
			name: 'Current setup · Aug 9, 3:15 AM',
			copiedFromSetupId: source.id,
		});
		workspace.succeed(saved);
		TestBed.flushEffects();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
			setup: { id: 'setup-2' },
			retainedLocally: true,
		});
		expect(store.current()?.id).toBe('setup-2');
		expect(store.setups()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'setup-2', current: true }),
				expect.objectContaining({ id: 'setup-1', current: false }),
			]),
		);
		expect(store.saveError()).toBe('');
		gateway.setFailure({ kind: 'unavailable' });
		expect(store.failure()).toBeNull();
		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('idle');
	});

	it('keeps CurrentSetupGateway as the connected mutation transport', () => {
		workspace.durableSetupMutationsAvailable.set(false);
		const source = snapshot();
		gateway.setCollection({ currentSetupId: source.id, setups: [source] });
		store.selectCar('car-1');
		TestBed.flushEffects();

		store.saveCurrentSetup(command());
		expect(gateway.saveCurrentSetup).toHaveBeenCalledWith(command());
		expect(workspace.commitSetup).not.toHaveBeenCalled();
		store.saveCurrentSetup(command({ sourceSetupId: 'duplicate' }));
		expect(gateway.saveCurrentSetup).toHaveBeenCalledOnce();

		const saved = snapshot({
			id: 'setup-2',
			name: 'Connected save',
			copiedFromSetupId: source.id,
		});
		gateway.succeedSave(saved);
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			setup: { id: 'setup-2' },
			retainedLocally: false,
		});
		expect(store.current()?.id).toBe('setup-2');
		expect(store.setups()).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ id: 'setup-2', current: true }),
				expect.objectContaining({ id: 'setup-1', current: false }),
			]),
		);
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});

	it('ignores stale connected gateway completions', () => {
		workspace.durableSetupMutationsAvailable.set(false);
		const source = snapshot();
		gateway.setCollection({ currentSetupId: source.id, setups: [source] });
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.succeedSave(snapshot({ id: 'stale-success' }));
		expect(store.outcome().status).toBe('pending');

		store.selectCar('car-2');
		store.selectCar('car-1');
		gateway.resetSave();
		store.saveCurrentSetup(command());
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.failSave({ kind: 'unavailable' });
		expect(store.outcome().status).toBe('pending');
	});

	it('publishes a local failure when durable coordination refuses the save', () => {
		workspace.acceptSetupCommits.set(false);
		const source = snapshot();
		gateway.setCollection({ currentSetupId: source.id, setups: [source] });
		store.selectCar('car-1');
		store.saveCurrentSetup(
			command({
				draft: {
					...command().draft,
					sections: {
						...command().draft.sections,
						notes: { setupNotes: 'Fresh notes' },
					},
				},
			}),
		);
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'local' },
		});
	});

	it('maps connected gateway failures and unavailable online-only saves', () => {
		workspace.durableSetupMutationsAvailable.set(false);
		const source = snapshot();
		gateway.setCollection({ currentSetupId: source.id, setups: [source] });
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		gateway.failSave({
			kind: 'rejected-response',
			status: 422,
			message: 'Review the connected setup.',
		});
		expect(store.saveError()).toBe('Review the connected setup.');

		gateway.resetSave();
		workspace.externalRequestsAvailable.set(false);
		store.saveCurrentSetup(command());
		expect(gateway.saveCurrentSetup).toHaveBeenCalledOnce();
		expect(store.saveError()).toContain('could not be saved');
	});

	it('validates commands, rejects stale sources, and maps save failures', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.selectCar('car-1');
		store.saveCurrentSetup(
			command({ draft: { ...command().draft, name: '   ' } }),
		);
		expect(store.saveError()).toContain('Name this setup');
		expect(workspace.commitSetup).not.toHaveBeenCalled();

		store.saveCurrentSetup(command({ sourceSetupId: 'stale' }));
		expect(store.saveError()).toContain('changed while you were editing');
		expect(store.outcome()).toMatchObject({ operationId: 2 });
		store.saveCurrentSetup(command({ sourceUpdatedAt: '' }));
		expect(store.saveError()).toContain('changed while you were editing');

		store.saveCurrentSetup(
			command({ sourceUpdatedAt: '2026-08-09T21:00:01.000Z' }),
		);
		expect(store.saveError()).toContain('changed while you were editing');

		store.saveCurrentSetup(command());
		workspace.fail({ kind: 'http', status: 401 });
		TestBed.flushEffects();
		expect(store.saveError()).toContain('session has expired');

		store.saveCurrentSetup(command());
		workspace.fail({ kind: 'http', status: 409 });
		TestBed.flushEffects();
		expect(store.saveError()).toContain('Restore this car');

		store.saveCurrentSetup(command());
		workspace.fail({ kind: 'unavailable' });
		TestBed.flushEffects();
		expect(store.saveError()).toContain('could not be saved');

		for (const failure of [
			{ kind: 'local', message: 'IndexedDB failed.' } as const,
			{
				kind: 'needs-attention',
				feedback: { code: 'invalid', message: 'Review the setup values.' },
			} as const,
			{
				kind: 'conflict',
				feedback: { code: 'conflict', message: 'Choose the current setup.' },
				remote: {
					currentSetupId: 'remote',
					currentSetupVersion: 2,
					setup: syncedSnapshot({ id: 'remote' }),
				},
			} as const,
		]) {
			store.saveCurrentSetup(command());
			workspace.fail(failure);
			TestBed.flushEffects();
			expect(store.saveError()).toBe(
				failure.kind === 'local' ? failure.message : failure.feedback.message,
			);
		}
	});

	it('cancels stale route mutations and ignores commands for another car', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.saveCurrentSetup(command());
		expect(workspace.commitSetup).not.toHaveBeenCalled();
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		store.selectCar('car-2');
		expect(store.outcome().status).toBe('idle');
		workspace.succeed(syncedSnapshot({ id: 'stale-save' }));
		TestBed.flushEffects();
		expect(store.current()).toBeNull();
		expect(store.setups()).toEqual([]);

		store.clearSaveOutcome();
		expect(store.outcome().status).toBe('idle');
	});

	it('guards workspace outcomes with the captured route generation', () => {
		gateway.setCollection({ currentSetupId: 'setup-1', setups: [snapshot()] });
		store.selectCar('car-1');
		store.saveCurrentSetup(command());
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		workspace.succeed(syncedSnapshot({ id: 'stale-success' }));
		TestBed.flushEffects();
		expect(store.outcome().status).toBe('pending');
	});

	it('keeps cached setup history readable when the remote read fails', () => {
		store.selectCar('car-1');
		workspace.setupCollections.set([
			{
				carId: 'car-1',
				currentSetupId: 'cached',
				currentSetupVersion: 3,
				setups: [
					syncedSnapshot({
						id: 'cached',
						context: null,
						copiedFromSetupId: undefined,
					}),
				],
			},
		]);
		gateway.setFailure({ kind: 'unavailable' });
		expect(store.current()?.id).toBe('cached');
		expect(store.current()?.context).toEqual({});
		expect(store.current()?.copiedFromSetupId).toBeNull();
		expect(store.failure()).toBeNull();
		expect(store.syncMark()).toEqual({ kind: 'synced' });
	});
});
