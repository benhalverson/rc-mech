import { InjectionToken, inject, Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { LocalVoiceStatus, PendingVoiceCapture } from './voice.models';

const createVoiceQueueDatabase = (): Dexie => {
	const database = new Dexie('rc-mech-voice-queue');
	database.version(1).stores({
		captures: 'id,ownerKey,carId,[ownerKey+carId],createdAt,status',
	});
	return database;
};

export const VOICE_QUEUE_DATABASE = new InjectionToken<Dexie>(
	'VOICE_QUEUE_DATABASE',
	{ providedIn: 'root', factory: createVoiceQueueDatabase },
);

@Service()
export class VoiceOfflineQueue {
	private readonly database = inject(VOICE_QUEUE_DATABASE);
	private readonly captures: Table<PendingVoiceCapture, string> =
		this.database.table('captures');

	createId(): string {
		return crypto.randomUUID();
	}

	async put(capture: PendingVoiceCapture): Promise<void> {
		await this.captures.put(capture);
	}

	async list(ownerKey: string): Promise<PendingVoiceCapture[]> {
		return this.captures.where('ownerKey').equals(ownerKey).sortBy('createdAt');
	}

	async updateStatus(
		id: string,
		status: LocalVoiceStatus,
		error: string | null,
	): Promise<void> {
		await this.captures.update(id, { status, error });
	}

	async remove(id: string): Promise<void> {
		await this.captures.delete(id);
	}
}
