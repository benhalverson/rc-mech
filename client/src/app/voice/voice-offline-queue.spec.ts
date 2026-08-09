import { TestBed } from '@angular/core/testing';
import Dexie from 'dexie';
import { IDBKeyRange, indexedDB } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';
import type { PendingVoiceCapture } from './voice.models';
import { VOICE_QUEUE_DATABASE, VoiceOfflineQueue } from './voice-offline-queue';

const capture = (
	id: string,
	ownerKey: string,
	createdAt: string,
): PendingVoiceCapture => ({
	id,
	ownerKey,
	carId: 'car-1',
	driveSessionId: null,
	text: 'Track note',
	contentType: 'text/plain',
	fileName: `${id}.txt`,
	createdAt,
	status: 'local',
	error: null,
});

describe('VoiceOfflineQueue', () => {
	let database: Dexie | undefined;

	afterEach(async () => {
		if (database) {
			database.close();
			await Dexie.delete(database.name);
		}
		database = undefined;
		TestBed.resetTestingModule();
	});

	it('partitions, orders, updates, and removes pending captures', async () => {
		Dexie.dependencies.indexedDB = indexedDB;
		Dexie.dependencies.IDBKeyRange = IDBKeyRange;
		TestBed.configureTestingModule({ providers: [VoiceOfflineQueue] });
		const queue = TestBed.inject(VoiceOfflineQueue);
		database = TestBed.inject(VOICE_QUEUE_DATABASE);
		expect(queue.createId()).toMatch(/^[0-9a-f-]{36}$/i);

		await queue.put(capture('later', 'owner-a', '2026-08-08T02:00:00.000Z'));
		await queue.put(
			capture('other-owner', 'owner-b', '2026-08-08T00:00:00.000Z'),
		);
		await queue.put(capture('earlier', 'owner-a', '2026-08-08T01:00:00.000Z'));

		expect((await queue.list('owner-a')).map(({ id }) => id)).toEqual([
			'earlier',
			'later',
		]);
		expect((await queue.list('owner-b')).map(({ id }) => id)).toEqual([
			'other-owner',
		]);

		await queue.updateStatus('earlier', 'queued', 'Waiting for a connection.');
		expect(await queue.list('owner-a')).toContainEqual(
			expect.objectContaining({
				id: 'earlier',
				status: 'queued',
				error: 'Waiting for a connection.',
			}),
		);

		await queue.remove('earlier');
		expect((await queue.list('owner-a')).map(({ id }) => id)).toEqual([
			'later',
		]);
	});
});
