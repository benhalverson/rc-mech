import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { VoiceLegacyMigration } from './voice-legacy-migration';
import { VoiceOfflineQueue } from './voice-offline-queue';
import { voiceCaptureFixture as capture } from './voice-sync.testing';

afterEach(() => TestBed.resetTestingModule());
it('copies original bytes and stable identities before deleting the legacy copy', async () => {
	const order: string[] = [];
	const blob = new Blob(['original audio']);
	const captures = [{ ...capture, ownerKey: 'owner@example.com', blob }];
	const legacy = {
		list: vi.fn(async () => captures),
		remove: vi.fn(async () => {
			order.push('delete');
		}),
	};
	const storage = {
		importVoice: vi.fn(async () => {
			order.push('copy');
		}),
	};
	TestBed.configureTestingModule({
		providers: [
			{ provide: VoiceOfflineQueue, useValue: legacy },
			{ provide: OfflineGarageStorage, useValue: storage },
		],
	});
	const migration = TestBed.inject(VoiceLegacyMigration);
	const fence = { ownerKey: 'owner-id', sessionKey: 'session' };
	await migration.migrate(' OWNER@example.com ', fence);
	expect(legacy.list).toHaveBeenCalledWith('owner@example.com');
	expect(storage.importVoice).toHaveBeenCalledWith(captures, fence);
	expect(order).toEqual(['copy', 'delete']);
	storage.importVoice.mockRejectedValueOnce(new Error('Disk full'));
	await expect(migration.migrate('owner@example.com', fence)).rejects.toThrow(
		'Disk full',
	);
	expect(legacy.remove).toHaveBeenCalledOnce();
	legacy.remove.mockRejectedValueOnce(new Error('Restart'));
	await expect(migration.migrate('owner@example.com', fence)).rejects.toThrow(
		'Restart',
	);
	await migration.migrate('owner@example.com', fence);
	expect(storage.importVoice).toHaveBeenCalledTimes(4);
	await expect(
		migration.pendingForSignOut(' OWNER@example.com '),
	).resolves.toEqual([capture.id]);
	await migration.discardForSignOut(' OWNER@example.com ');
	expect(legacy.remove).toHaveBeenLastCalledWith(capture.id);
});
