import { inject, Service } from '@angular/core';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { VoiceOfflineQueue } from './voice-offline-queue';
/** Copy first, then delete: a crash at either boundary preserves stable capture IDs. */
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
