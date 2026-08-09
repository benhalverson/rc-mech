import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type SetupGatewayFailure,
	type SetupSnapshot,
	SetupSnapshotGateway,
	SoDialedImportGateway,
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
	readonly collection = {
		hasValue: () => false,
		value: () => [],
		isLoading: signal(false),
	};
	readonly failure = vi.fn(() => null);
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
}

class FakeImporter {
	private cancelResult = new Subject<void>();
	readonly cancel = vi.fn(
		(_draftId: string): Observable<void> => this.cancelResult.asObservable(),
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
});
