import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, of, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	CarWorkspaceStore,
	type SetupWorkspaceMutationFailure,
	type SetupWorkspaceMutationOutcome,
} from '../../garage/car-sync/car-workspace-store';
import {
	type SetupGatewayFailure,
	type SetupImportReview,
	type SetupSnapshot,
	type SetupSnapshotDraft,
	SetupSnapshotGateway,
	SoDialedImportGateway,
	type SoDialedImportPreview,
} from './setup-snapshot';
import {
	SetupSnapshotStore,
	type SetupWorkflowCommand,
	setupCollectionAfterResult,
} from './setup-snapshot-store';
import type {
	SetupSyncCollection,
	SetupSyncCommand,
} from './setup-sync.models';

const snapshot = (
	id: string,
	overrides: Partial<SetupSnapshot> = {},
): SetupSnapshot => ({
	id,
	carId: 'car-1',
	name: id,
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	...overrides,
});

describe('setupCollectionAfterResult', () => {
	it('replaces, inserts, and selects setup results without shadow UI state', () => {
		const first = snapshot('setup-1', { current: true });
		const updated = snapshot('setup-1', { name: 'Updated' });
		expect(
			setupCollectionAfterResult(
				[first],
				{ kind: 'save', setup: updated, targetCarId: 'car-1' },
				'car-1',
			),
		).toEqual([updated]);
		expect(
			setupCollectionAfterResult(
				[first],
				{
					kind: 'save',
					setup: snapshot('setup-2'),
					targetCarId: 'car-2',
				},
				'car-1',
			),
		).toBeNull();

		const copied = snapshot('setup-2');
		expect(
			setupCollectionAfterResult(
				[first],
				{ kind: 'copy', setup: copied },
				'car-1',
			),
		).toEqual([copied, first]);
		expect(
			setupCollectionAfterResult(
				[first, copied],
				{ kind: 'select-current', setup: copied },
				'car-1',
			),
		).toEqual([
			{ ...first, current: false },
			{ ...copied, current: true },
		]);
		expect(
			setupCollectionAfterResult([first], { kind: 'cancel-import' }, 'car-1'),
		).toBeNull();
	});
});

class FakeSnapshotGateway {
	readonly synchronizedCollection = signal<SetupSyncCollection | null>(null);
	readonly hasCollection = signal(false);
	readonly collectionValue = signal<SetupSnapshot[]>([]);
	readonly collection = {
		hasValue: () => this.hasCollection(),
		value: vi.fn(() => this.collectionValue()),
		isLoading: signal(false),
	};
	readonly failureValue = signal<SetupGatewayFailure | null>(null);
	readonly failure = vi.fn(() => this.failureValue());
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
	createResult: Observable<SetupSnapshot> = of(snapshot('created'));
	updateResult: Observable<SetupSnapshot> = of(snapshot('updated'));
	copyResult: Observable<SetupSnapshot> = of(snapshot('copied'));
	currentResult: Observable<SetupSnapshot> = of(snapshot('current'));
	readonly create = vi.fn(
		(_carId: string, _draft: SetupSnapshotDraft): Observable<SetupSnapshot> =>
			this.createResult,
	);
	readonly update = vi.fn(
		(
			_carId: string,
			_setupId: string,
			_draft: SetupSnapshotDraft,
		): Observable<SetupSnapshot> => this.updateResult,
	);
	readonly copy = vi.fn(
		(_carId: string, _setupId: string): Observable<SetupSnapshot> =>
			this.copyResult,
	);
	readonly selectCurrent = vi.fn(
		(_carId: string, _setupId: string): Observable<SetupSnapshot> =>
			this.currentResult,
	);
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
	readonly observeServerSetupCollection = vi.fn();
	readonly setupMark = vi.fn(() => ({ kind: 'synced' }) as const);
	private requestId = 0;

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

class FakeImporter {
	private cancelResult = new Subject<void>();
	previewResult: Observable<SoDialedImportPreview> = of({
		draftId: 'draft-1',
		source: {},
		carIdentity: {},
		context: {},
		sections: snapshot('preview').sections,
		uncertainValues: {},
		unmappedValues: {},
		rawValues: {},
	});
	updateResult: Observable<void> = of(undefined);
	acceptResult: Observable<SetupSnapshot> = of(snapshot('imported'));
	readonly preview = vi.fn(
		(_url: string, _carId: string): Observable<SoDialedImportPreview> =>
			this.previewResult,
	);
	readonly cancel = vi.fn(
		(_draftId: string): Observable<void> => this.cancelResult.asObservable(),
	);
	readonly update = vi.fn(
		(_draftId: string, _review: SetupImportReview): Observable<void> =>
			this.updateResult,
	);
	readonly accept = vi.fn(
		(
			_draftId: string,
			_carId: string,
			_name: string,
		): Observable<SetupSnapshot> => this.acceptResult,
	);

	succeedCancel(): void {
		this.cancelResult.next();
		this.cancelResult.complete();
	}

	failCancel(failure: SetupGatewayFailure): void {
		this.cancelResult.error(failure);
	}
}

describe('SetupSnapshotStore focused commands', () => {
	let gateway: FakeSnapshotGateway;
	let importer: FakeImporter;
	let workspace: FakeWorkspace;
	let store: InstanceType<typeof SetupSnapshotStore>;

	beforeEach(() => {
		gateway = new FakeSnapshotGateway();
		importer = new FakeImporter();
		workspace = new FakeWorkspace();
		TestBed.configureTestingModule({
			providers: [
				SetupSnapshotStore,
				{ provide: SetupSnapshotGateway, useValue: gateway },
				{ provide: SoDialedImportGateway, useValue: importer },
				{ provide: CarWorkspaceStore, useValue: workspace },
			],
		});
		store = TestBed.inject(SetupSnapshotStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('guards commands, exposes cancel state, and supports both reload aliases', () => {
		const cancel: SetupWorkflowCommand = {
			kind: 'cancel-import',
			draftId: 'draft-1',
		};
		expect(store.setups()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.failure()).toBeNull();
		expect(store.action()).toBeNull();
		expect(store.syncMark()).toEqual({ kind: 'synced' });
		store.mutate(cancel);
		expect(importer.cancel).not.toHaveBeenCalled();

		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();
		store.retry();
		store.refresh();
		expect(gateway.refresh).toHaveBeenCalledTimes(2);

		store.mutate(cancel);
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operationId: 1,
		});
		expect(store.action()).toBeNull();
		store.mutate(cancel);
		expect(importer.cancel).toHaveBeenCalledOnce();
		importer.succeedCancel();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			result: { kind: 'cancel-import' },
		});
		store.clearOutcome();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('publishes a typed cancel failure for the active route', () => {
		store.selectCar('car-1');
		store.mutate({ kind: 'cancel-import', draftId: 'draft-1' });
		importer.failCancel({ kind: 'unavailable' });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'unavailable' },
		});
	});

	it('executes preview, create, edit, import, copy, and current commands', () => {
		store.selectCar('car-1');
		store.mutate({
			kind: 'preview',
			carId: 'car-1',
			url: 'https://sodialed.com/setup/abc',
		});
		expect(importer.preview).toHaveBeenCalledWith(
			'https://sodialed.com/setup/abc',
			'car-1',
		);
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			result: { kind: 'preview' },
		});

		const draft: SetupSnapshotDraft = { name: 'Baseline' };
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'add',
			setupId: null,
			snapshot: draft,
			importDraft: null,
		});
		expect(workspace.commitSetup).toHaveBeenLastCalledWith({
			type: 'create',
			carId: 'car-1',
			draft,
		});
		workspace.succeed(snapshot('created'));
		TestBed.flushEffects();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			result: { kind: 'save', retainedLocally: true },
		});

		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'edit',
			setupId: 'setup-1',
			snapshot: draft,
			importDraft: null,
		});
		expect(workspace.commitSetup).toHaveBeenLastCalledWith({
			type: 'correct',
			carId: 'car-1',
			setupId: 'setup-1',
			draft,
		});
		workspace.succeed(snapshot('setup-1', { name: 'Corrected' }));
		TestBed.flushEffects();

		const review: SetupImportReview = {
			carId: 'car-2',
			knownValues: {},
			uncertainValues: {},
			rawValues: {},
			unmappedValues: {},
			sourceMetadata: {},
		};
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-2',
			mode: 'add',
			setupId: null,
			snapshot: draft,
			importDraft: { draftId: 'draft-1', review, name: 'Imported' },
		});
		expect(importer.update).toHaveBeenCalledWith('draft-1', review);
		expect(importer.accept).toHaveBeenCalledWith(
			'draft-1',
			'car-2',
			'Imported',
		);
		expect(store.setups().some((entry) => entry.id === 'imported')).toBe(false);

		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'created' });
		expect(workspace.commitSetup).toHaveBeenLastCalledWith({
			type: 'copy',
			carId: 'car-1',
			setupId: 'created',
		});
		expect(store.action()).toBe('copy');
		workspace.succeed(snapshot('copied'));
		TestBed.flushEffects();

		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'created',
		});
		expect(workspace.commitSetup).toHaveBeenLastCalledWith({
			type: 'select-current',
			carId: 'car-1',
			setupId: 'created',
		});
		workspace.succeed(snapshot('created', { current: true }), false);
		TestBed.flushEffects();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			result: { kind: 'select-current', retainedLocally: false },
		});
	});

	it('keeps feature gateway mutations active without a durable workspace', () => {
		workspace.durableSetupMutationsAvailable.set(false);
		store.selectCar('car-1');
		const draft: SetupSnapshotDraft = { name: 'Connected setup' };

		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'add',
			setupId: null,
			snapshot: draft,
			importDraft: null,
		});
		expect(gateway.create).toHaveBeenCalledWith('car-1', draft);

		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'edit',
			setupId: 'created',
			snapshot: draft,
			importDraft: null,
		});
		expect(gateway.update).toHaveBeenCalledWith('car-1', 'created', draft);

		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'created' });
		expect(gateway.copy).toHaveBeenCalledWith('car-1', 'created');

		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'created',
		});
		expect(gateway.selectCurrent).toHaveBeenCalledWith('car-1', 'created');
		expect(workspace.commitSetup).not.toHaveBeenCalled();
		expect(gateway.refresh).toHaveBeenCalledTimes(4);
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			result: { kind: 'select-current', setup: { id: 'current' } },
		});
	});

	it('ignores late connected gateway results after the route changes', () => {
		workspace.durableSetupMutationsAvailable.set(false);
		const copy = new Subject<SetupSnapshot>();
		gateway.copyResult = copy;
		store.selectCar('car-1');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'setup-1' });
		store.selectCar('car-2');
		copy.next(snapshot('late-copy'));
		copy.complete();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
		expect(gateway.refresh).not.toHaveBeenCalled();

		const update = new Subject<SetupSnapshot>();
		gateway.updateResult = update;
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-2',
			targetCarId: 'car-2',
			mode: 'edit',
			setupId: 'setup-2',
			snapshot: { name: 'Late correction' },
			importDraft: null,
		});
		store.selectCar('car-3');
		update.error({ kind: 'unavailable' } satisfies SetupGatewayFailure);
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('publishes a local failure when durable coordination refuses a command', () => {
		workspace.acceptSetupCommits.set(false);
		store.selectCar('car-1');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'setup-1' });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'local' },
		});
	});

	it('exposes loading, collection, failure, and pending action states', () => {
		TestBed.flushEffects();
		gateway.collection.isLoading.set(true);
		expect(store.loading()).toBe(true);
		gateway.failureValue.set({ kind: 'http', status: 401 });
		expect(store.failure()).toMatchObject({ retryable: false });
		gateway.failureValue.set({ kind: 'unavailable' });
		expect(store.failure()).toMatchObject({ retryable: true });
		gateway.failureValue.set(null);
		expect(store.failure()).toBeNull();

		gateway.hasCollection.set(true);
		gateway.collectionValue.set([snapshot('remote')]);
		gateway.synchronizedCollection.set({
			carId: 'car-1',
			currentSetupId: null,
			currentSetupVersion: 0,
			setups: [snapshot('remote')],
		});
		TestBed.flushEffects();
		expect(gateway.collection.value).not.toHaveBeenCalled();
		gateway.collection.isLoading.set(false);
		TestBed.flushEffects();
		expect(gateway.collection.value).toHaveBeenCalled();
		expect(workspace.observeServerSetupCollection).toHaveBeenCalledWith(
			gateway.synchronizedCollection(),
		);
		const observationCount =
			workspace.observeServerSetupCollection.mock.calls.length;
		gateway.synchronizedCollection.set(null);
		TestBed.flushEffects();
		expect(workspace.observeServerSetupCollection).toHaveBeenCalledTimes(
			observationCount,
		);
		expect(store.setups()).toEqual([snapshot('remote')]);

		store.selectCar('car-1');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'remote' });
		expect(store.action()).toBe('copy');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'remote' });
		expect(workspace.commitSetup).toHaveBeenCalledOnce();
		workspace.succeed(snapshot('copy'));
		TestBed.flushEffects();

		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'remote',
		});
		expect(store.action()).toBe('current');
		workspace.succeed(snapshot('remote', { current: true }));
		TestBed.flushEffects();
	});

	it('ignores late successes and failures after the active car changes', () => {
		store.selectCar('car-1');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'setup-1' });
		store.selectCar('car-2');
		workspace.succeed(snapshot('late'));
		TestBed.flushEffects();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
		expect(gateway.refresh).not.toHaveBeenCalled();

		store.mutate({ kind: 'copy', carId: 'car-2', setupId: 'setup-2' });
		store.selectCar('car-3');
		workspace.fail({ kind: 'unavailable' });
		TestBed.flushEffects();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('publishes active local, terminal, conflict, and gateway mutation failures', () => {
		store.selectCar('car-1');
		const command: SetupWorkflowCommand = {
			kind: 'copy',
			carId: 'car-1',
			setupId: 'setup-1',
		};
		const failures: readonly SetupWorkspaceMutationFailure[] = [
			{ kind: 'local', message: 'IndexedDB failed.' },
			{
				kind: 'needs-attention',
				feedback: { code: 'invalid', message: 'Review this setup.' },
			},
			{
				kind: 'conflict',
				feedback: { code: 'conflict', message: 'Choose a current setup.' },
				remote: {
					currentSetupId: null,
					currentSetupVersion: 2,
					setup: null,
				},
			},
			{ kind: 'invalid-response' },
		];
		for (const failure of failures) {
			store.clearOutcome();
			store.mutate(command);
			workspace.fail(failure);
			TestBed.flushEffects();
			expect(store.outcome()).toMatchObject({
				status: 'failed',
				error:
					failure.kind === 'needs-attention' || failure.kind === 'conflict'
						? { kind: failure.kind, message: failure.feedback.message }
						: failure,
			});
		}
	});

	it('uses durable setup history while offline and blocks uncached imports', () => {
		store.selectCar('car-1');
		workspace.setupCollections.set([
			{
				carId: 'car-1',
				currentSetupId: 'local',
				currentSetupVersion: 1,
				setups: [snapshot('local', { current: true })],
			},
		]);
		gateway.failureValue.set({ kind: 'unavailable' });
		expect(store.setups()).toEqual([snapshot('local', { current: true })]);
		expect(store.failure()).toBeNull();

		workspace.externalRequestsAvailable.set(false);
		store.mutate({
			kind: 'preview',
			carId: 'car-1',
			url: 'https://sodialed.com/setup/offline',
		});
		expect(importer.preview).not.toHaveBeenCalled();
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'unavailable' },
		});
	});
});
