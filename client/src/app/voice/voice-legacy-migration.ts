import { inject, Service } from '@angular/core';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { VoiceOfflineQueue } from './voice-offline-queue';
/**
 * Bridges VoiceOfflineQueue into the shared workspace for VoiceWorkspaceStore.
 * Copies owner-matched captures under the current fence before deleting legacy
 * entries, preserving stable IDs across interrupted migration. Keep the reader
 * until deployed-consumer and production-data checks establish safe removal.
 */
@Service()
export class VoiceLegacyMigration {
	private readonly legacy = inject(VoiceOfflineQueue);
	private readonly storage = inject(OfflineGarageStorage);
	async migrate(email: string, fence: OfflineWorkspaceFence): Promise<void> {
		const captures = await this.legacy.list(email.trim().toLowerCase());
		await this.storage.importVoice(captures, fence);
		for (const capture of captures) await this.legacy.remove(capture.id);
	}
}
