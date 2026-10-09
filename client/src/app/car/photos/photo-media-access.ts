import { InjectionToken, inject, Service } from '@angular/core';
import { firstValueFrom, fromEvent, takeUntil } from 'rxjs';
import {
	OfflineGarageStorage,
	type OfflineWorkspaceFence,
} from '../../offline/offline-garage-storage';
import { PhotoSyncGateway } from './photo-sync-gateway';

export const PHOTO_OBJECT_URL = new InjectionToken<
	Pick<typeof URL, 'createObjectURL' | 'revokeObjectURL'>
>('PHOTO_OBJECT_URL', { factory: () => URL });
/**
 * Turns photo bytes into display URLs for CarPhotoStore. Reads the owner-fenced
 * local original first and fetches/retains it through PhotoSyncGateway when online.
 * Each display URL belongs to the calling resource load: abort cancels HTTP and
 * revokes that URL. Cache retention is idempotent and checks the owner/session and
 * photo revision transactionally; cancellation never queues a gallery mutation.
 */
@Service()
export class PhotoMediaAccess {
	private readonly storage = inject(OfflineGarageStorage);
	private readonly gateway = inject(PhotoSyncGateway);
	private readonly urls = inject(PHOTO_OBJECT_URL);
	async open(
		photoId: string,
		fence: OfflineWorkspaceFence,
		offline: boolean,
		abortSignal: AbortSignal,
	): Promise<string | null> {
		let blob = await this.storage.retainedPhoto(photoId, fence);
		if (abortSignal.aborted) return null;
		if (!blob && !offline) {
			const original = await firstValueFrom(
				this.gateway
					.original(photoId)
					.pipe(takeUntil(fromEvent(abortSignal, 'abort'))),
				{ defaultValue: null },
			);
			if (!original || abortSignal.aborted) return null;
			blob = original.blob;
			await this.storage.retainPhoto(photoId, blob, fence, original.revision);
		}
		if (!blob || abortSignal.aborted) return null;
		const url = this.urls.createObjectURL(blob);
		abortSignal.addEventListener(
			'abort',
			() => this.urls.revokeObjectURL(url),
			{ once: true },
		);
		return url;
	}
}
