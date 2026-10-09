import { InjectionToken, inject, Service } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../../offline/offline-garage-storage';
import { PhotoSyncGateway } from './photo-sync-gateway';

export const PHOTO_OBJECT_URL = new InjectionToken<
	Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
>('PHOTO_OBJECT_URL', { factory: () => URL });
@Service()
export class PhotoMediaAccess {
	private readonly storage = inject(OfflineGarageStorage);
	private readonly gateway = inject(PhotoSyncGateway);
	private readonly urls = inject(PHOTO_OBJECT_URL);
	private readonly handles = new Set<string>();
	private generation = 0;
	async open(
		photoId: string,
		fence: OfflineWorkspaceFence,
		offline: boolean,
	): Promise<string | null> {
		const generation = this.generation;
		let blob = await this.storage.retainedPhoto(photoId, fence);
		if (!blob && !offline) {
			blob = await firstValueFrom(this.gateway.original(photoId));
			await this.storage.retainPhoto(photoId, blob, fence);
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
