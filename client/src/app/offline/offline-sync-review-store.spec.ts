import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { MaintenanceWorkspaceStore } from '../maintenance/maintenance-workspace-store';
import { SettingsWorkspaceStore } from '../settings/settings-workspace-store';
import { VoiceWorkspaceStore } from '../voice/voice-workspace-store';
import { OfflineGarageStorage } from './offline-garage-storage';
import {
	reviewedSetup,
	syncReviewFixtures,
} from './offline-sync-review.testing';
import { OfflineSyncReviewStore } from './offline-sync-review-store';
import { OfflineWorkspaceStore } from './offline-workspace-store';

afterEach(() => TestBed.resetTestingModule());
it('coordinates durable review decisions and fences late failures by owner and session', async () => {
	const hasSnapshot = signal(false),
		ownerKey = signal('user-a'),
		sessionKey = signal('session-a');
	const open = vi.fn();
	const operations = (family: string) =>
		syncReviewFixtures
			.filter((value) => value.family === family)
			.map((value) => value.operation);
	let resolve!: () => void;
	const resolveSyncReview = vi.fn(
		() =>
			new Promise<void>((done) => {
				resolve = done;
			}),
	);
	TestBed.configureTestingModule({
		providers: [
			{
				provide: OfflineWorkspaceStore,
				useValue: { hasSnapshot, ownerKey, sessionKey },
			},
			{ provide: OfflineGarageStorage, useValue: { resolveSyncReview } },
			{
				provide: CarWorkspaceStore,
				useValue: {
					open,
					operations: () => [...operations('car'), { status: 'pending' }],
					setupOperations: () => operations('setup'),
					buildOperations: () => operations('build'),
					driveOperations: () => operations('drive'),
					cars: () => [{ id: 'car', name: 'Buggy' }],
					setupCollections: () => [{ setups: [reviewedSetup] }],
					buildCollections: () => [
						{ components: [{ id: 'component', name: 'Motor' }] },
					],
				},
			},
			{
				provide: MaintenanceWorkspaceStore,
				useValue: {
					open,
					operations: () => operations('maintenance'),
					plans: () => [{ id: 'plan', name: 'Motor service' }],
				},
			},
			{
				provide: SettingsWorkspaceStore,
				useValue: { open, operations: () => operations('settings') },
			},
			{ provide: VoiceWorkspaceStore, useValue: { open } },
		],
	});
	const store = TestBed.inject(OfflineSyncReviewStore);
	expect(store.reviews()).toEqual([]);
	hasSnapshot.set(true);
	expect(store.reviews()).toHaveLength(8);
	expect(store.names()).toEqual({
		car: 'Buggy',
		component: 'Motor',
		setup: 'Saved setup',
		plan: 'Motor service',
	});
	store.resolve(syncReviewFixtures[0], 'device');
	store.resolve(syncReviewFixtures[0], 'device');
	expect(resolveSyncReview).toHaveBeenCalledOnce();
	resolve();
	await vi.waitFor(() => expect(store.pending()).toBe(false));
	expect(open).toHaveBeenCalledTimes(4);
	resolveSyncReview.mockRejectedValueOnce(new Error('stale'));
	store.resolve(syncReviewFixtures[0], 'remote');
	await vi.waitFor(() => expect(store.error()).toContain('could not be saved'));
	for (const change of [
		() => ownerKey.set('other'),
		() => sessionKey.set('other'),
	]) {
		let reject!: (error: Error) => void;
		resolveSyncReview.mockImplementationOnce(
			() =>
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
		);
		store.resolve(syncReviewFixtures[0], 'remote');
		change();
		reject(new Error('late'));
		await vi.waitFor(() => expect(store.pending()).toBe(false));
		expect(store.error()).toBe('');
	}
});
