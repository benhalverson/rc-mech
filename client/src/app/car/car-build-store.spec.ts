import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	type BuildWorkspaceMutationOutcome,
	CarWorkspaceStore,
} from '../garage/car-sync/car-workspace-store';
import type {
	BuildSyncCollection,
	BuildSyncOperation,
} from './build-sync/build-sync.models';
import { CarBuildGateway } from './car-build-gateway';
import { CarBuildStore } from './car-build-store';

const collection: BuildSyncCollection = {
	carId: 'car',
	version: 2,
	components: [{ id: 'motor', carId: 'car', slot: 'motor', name: 'Motor' }],
};

describe('local Build workflow', () => {
	const response = signal<
		| {
				components: typeof collection.components;
				carId?: string;
				version?: number;
		  }
		| undefined
	>(undefined);
	const workspace = {
		opened: signal(false),
		buildCollections: signal<readonly BuildSyncCollection[]>([]),
		buildOperations: signal<readonly BuildSyncOperation[]>([]),
		buildMutationOutcome: signal<BuildWorkspaceMutationOutcome>({
			status: 'idle',
			requestId: null,
		}),
		durableSetupMutationsAvailable: signal(false),
		commitBuild: vi.fn(),
		observeServerBuildCollection: vi.fn(),
	};
	const gateway = {
		collection: {
			hasValue: () => response() !== undefined,
			value: () => response(),
			isLoading: () => true,
		},
		selectCar: vi.fn(),
		refresh: vi.fn(),
		failure: () => ({ kind: 'unavailable' }),
	};
	let store: InstanceType<typeof CarBuildStore>;
	beforeEach(() => {
		response.set(undefined);
		workspace.opened.set(false);
		workspace.buildCollections.set([]);
		workspace.buildOperations.set([]);
		workspace.buildMutationOutcome.set({ status: 'idle', requestId: null });
		workspace.durableSetupMutationsAvailable.set(true);
		vi.clearAllMocks();
		TestBed.configureTestingModule({
			providers: [
				CarBuildStore,
				{ provide: CarWorkspaceStore, useValue: workspace },
				{ provide: CarBuildGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(CarBuildStore);
		store.selectCar('car');
	});
	afterEach(() => TestBed.resetTestingModule());

	it('uses the durable working copy during a network outage and observes versioned refreshes', () => {
		workspace.opened.set(true);
		workspace.buildCollections.set([collection]);
		expect(store.components()).toEqual(collection.components);
		expect(store.loading()).toBe(false);
		expect(store.failure()).toBeNull();
		response.set({ components: [], carId: 'car' });
		TestBed.tick();
		expect(workspace.observeServerBuildCollection).not.toHaveBeenCalled();
		response.set({ components: [], carId: 'car', version: 3 });
		TestBed.tick();
		expect(workspace.observeServerBuildCollection).toHaveBeenCalledWith({
			components: [],
			carId: 'car',
			version: 3,
		});
	});

	it.each(['add', 'edit', 'replace', 'remove'] as const)(
		'retains %s before reporting local success and clears Pending sync only for its own acknowledgement',
		(mode) => {
			store.save({
				mode,
				componentId: 'motor',
				input: { name: 'Motor', slot: 'motor' },
			});
			expect(store.outcome().status).toBe('pending');
			const command = workspace.commitBuild.mock.calls[0]?.[0];
			workspace.buildMutationOutcome.set({
				status: 'pending',
				requestId: 1,
				command,
			});
			TestBed.tick();
			expect(store.outcome().status).toBe('pending');
			workspace.buildMutationOutcome.set({
				status: 'succeeded',
				requestId: 1,
				command,
				operationId: 'build-op',
				collection,
			});
			workspace.buildOperations.set([
				{ operationId: 'build-op', carId: 'car' } as BuildSyncOperation,
			]);
			TestBed.tick();
			expect(store.outcome().status).toBe('succeeded');
			expect(store.syncOperations()).toHaveLength(1);
			expect(store.message()).toContain('Pending sync');
			workspace.buildOperations.set([
				{ operationId: 'unrelated', carId: 'other' } as BuildSyncOperation,
			]);
			expect(store.message()).not.toContain('Pending sync');
			expect(store.syncOperations()).toEqual([]);
			if (mode === 'remove') expect(store.message()).toContain('removed');
		},
	);

	it('retains the editor after a failed durable write and ignores unrelated outcomes', () => {
		store.save({ mode: 'add', componentId: null, input: { name: 'Motor' } });
		const command = workspace.commitBuild.mock.calls[0]?.[0];
		workspace.buildMutationOutcome.set({
			status: 'succeeded',
			requestId: 1,
			command: { ...command },
			operationId: 'other',
			collection,
		});
		TestBed.tick();
		expect(store.outcome().status).toBe('pending');
		workspace.buildMutationOutcome.set({
			status: 'failed',
			requestId: 1,
			command,
			error: { kind: 'local', message: 'Quota' },
		});
		TestBed.tick();
		expect(store.outcome().status).toBe('failed');
		expect(store.error()).toContain('could not be saved');
	});
});
