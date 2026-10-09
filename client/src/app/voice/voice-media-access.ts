import { InjectionToken, inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../offline/offline-garage-storage';
import { VoiceSyncGateway } from './voice-sync-gateway';

export const VOICE_OBJECT_URL = new InjectionToken<
	Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
>('VOICE_OBJECT_URL', { factory: () => URL });
/**
 * Provides VoiceLogStore with playback URLs for privately retained original audio.
 * Uses the fenced cache first and the sync gateway when online, retaining viewed
 * bytes for restart. Owns object-URL handles and invalidates late opens on clear(),
 * so browser resources do not leak into durable or cross-owner store state.
 */
@Service()
export class VoiceMediaAccess {
	private readonly storage = inject(OfflineGarageStorage);
	private readonly gateway = inject(VoiceSyncGateway);
	private readonly urls = inject(VOICE_OBJECT_URL);
	private readonly handles = new Set<string>();
	private generation = 0;
	async open(
		id: string,
		fence: OfflineWorkspaceFence,
		offline: boolean,
	): Promise<string | null> {
		const generation = this.generation;
		let blob = await this.storage.retainedVoiceOriginal(id, fence);
		if (!blob && !offline) {
			blob = await firstValueFrom(this.gateway.original(id));
			await this.storage.retainVoiceOriginal(id, blob, fence);
		}
		if (!blob || generation !== this.generation) return null;
		const url = this.urls.createObjectURL(blob);
		this.handles.add(url);
		return url;
	}
	clear(): void {
		this.generation++;
		for (const url of this.handles) this.urls.revokeObjectURL(url);
		this.handles.clear();
	}
}
