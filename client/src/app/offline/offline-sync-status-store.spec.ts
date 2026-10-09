import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it } from 'vitest';
import { PhotoWorkspaceStore } from '../car/photos/photo-workspace-store';
import { CarWorkspaceStore } from '../garage/car-sync/car-workspace-store';
import { MaintenanceWorkspaceStore } from '../maintenance/maintenance-workspace-store';
import { SettingsWorkspaceStore } from '../settings/settings-workspace-store';
import { VoiceWorkspaceStore } from '../voice/voice-workspace-store';
import { OfflineSyncStatusStore } from './offline-sync-status-store';
import { OfflineWorkspaceStore } from './offline-workspace-store';

afterEach(() => TestBed.resetTestingModule());
it('summarizes every workflow and clears the summary when the owner working copy closes', () => {
	const hasSnapshot = signal(false);
	const operations = signal<{ status: string }[]>([]);
	const voice = signal<{ status: string }[]>([]);
	const syncing = signal(false);
	const ids = signal<string[]>([]);
	TestBed.configureTestingModule({
		providers: [
			{ provide: OfflineWorkspaceStore, useValue: { hasSnapshot } },
			{
				provide: CarWorkspaceStore,
				useValue: {
					operations,
					setupOperations: () => [],
					buildOperations: () => [],
					driveOperations: () => [],
					syncingOperationIds: ids,
				},
			},
			{
				provide: MaintenanceWorkspaceStore,
				useValue: { operations: () => [], syncing },
			},
			{
				provide: SettingsWorkspaceStore,
				useValue: { operations: () => [], syncing },
			},
			{
				provide: PhotoWorkspaceStore,
				useValue: { captures: () => [], syncing },
			},
			{ provide: VoiceWorkspaceStore, useValue: { captures: voice, syncing } },
		],
	});
	const store = TestBed.inject(OfflineSyncStatusStore);
	expect(store.message()).toBe('');
	hasSnapshot.set(true);
	expect(store.message()).toBe('');
	operations.set([
		{ status: 'pending' },
		{ status: 'conflict' },
		{ status: 'needs-attention' },
	]);
	voice.set([{ status: 'queued' }, { status: 'failed' }]);
	expect(store.message()).toBe(
		'Pending sync: 2 · Needs attention: 2 · Sync conflict: 1',
	);
	syncing.set(true);
	expect(store.message()).toContain('Syncing');
	syncing.set(false);
	ids.set(['operation']);
	expect(store.message()).toContain('Syncing');
	hasSnapshot.set(false);
	expect(store.message()).toBe('');
});
