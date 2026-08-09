import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
	let store: InstanceType<typeof SetupSnapshotStore>;

	beforeEach(() => {
		gateway = new FakeSnapshotGateway();
		importer = new FakeImporter();
		TestBed.configureTestingModule({
			providers: [
				SetupSnapshotStore,
				{ provide: SetupSnapshotGateway, useValue: gateway },
				{ provide: SoDialedImportGateway, useValue: importer },
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
		expect(gateway.create).toHaveBeenCalledWith('car-1', draft);
		expect(store.setups()[0]?.id).toBe('created');
		expect(gateway.refresh).toHaveBeenCalledOnce();

		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'edit',
			setupId: 'setup-1',
			snapshot: draft,
			importDraft: null,
		});
		expect(gateway.update).toHaveBeenCalledWith('car-1', 'setup-1', draft);

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
		expect(gateway.copy).toHaveBeenCalledWith('car-1', 'created');
		expect(store.action()).toBeNull();
		expect(store.setups()[0]?.id).toBe('copied');

		gateway.currentResult = of(snapshot('created', { current: true }));
		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'created',
		});
		expect(gateway.selectCurrent).toHaveBeenCalledWith('car-1', 'created');
		expect(
			store.setups().find((entry) => entry.id === 'created')?.current,
		).toBe(true);
		expect(store.setups().find((entry) => entry.id === 'copied')?.current).toBe(
			false,
		);
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
		TestBed.flushEffects();
		expect(gateway.collection.value).not.toHaveBeenCalled();
		gateway.collection.isLoading.set(false);
		TestBed.flushEffects();
		expect(gateway.collection.value).toHaveBeenCalled();
		expect(store.setups()).toEqual([snapshot('remote')]);

		const pending = new Subject<SetupSnapshot>();
		gateway.copyResult = pending;
		store.selectCar('car-1');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'remote' });
		expect(store.action()).toBe('copy');
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'remote' });
		expect(gateway.copy).toHaveBeenCalledOnce();
		pending.next(snapshot('copy'));
		pending.complete();

		const selecting = new Subject<SetupSnapshot>();
		gateway.currentResult = selecting;
		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'remote',
		});
		expect(store.action()).toBe('current');
		selecting.next(snapshot('remote', { current: true }));
		selecting.complete();
	});

	it('ignores late successes and failures after the active car changes', () => {
		store.selectCar('car-1');
		const copy = new Subject<SetupSnapshot>();
		gateway.copyResult = copy;
		store.mutate({ kind: 'copy', carId: 'car-1', setupId: 'setup-1' });
		store.selectCar('car-2');
		copy.next(snapshot('late'));
		copy.complete();
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
		expect(gateway.refresh).not.toHaveBeenCalled();

		const failure = new Subject<SetupSnapshot>();
		gateway.copyResult = failure;
		store.mutate({ kind: 'copy', carId: 'car-2', setupId: 'setup-2' });
		store.selectCar('car-3');
		failure.error({ kind: 'unavailable' });
		expect(store.outcome()).toEqual({ status: 'idle', operationId: null });
	});

	it('publishes active mutation failures', () => {
		store.selectCar('car-1');
		gateway.createResult = throwError(() => ({ kind: 'invalid-response' }));
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'add',
			setupId: null,
			snapshot: { name: 'Bad' },
			importDraft: null,
		});
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			error: { kind: 'invalid-response' },
		});
	});
});
