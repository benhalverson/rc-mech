import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom } from 'rxjs';
import type { GarageCar } from '../garage/garage-store';
import { OwnerSessionStore } from '../owner-session-store';
import type {
	PendingVoiceCapture,
	VoiceListResponse,
	VoiceMutationResponse,
} from './voice.models';
import { VoiceOfflineQueue } from './voice-offline-queue';

type VoiceLogState = {
	carId: string;
	localCaptures: PendingVoiceCapture[];
	action: string | null;
	error: string;
	message: string;
};

const mutationMessage = (error: unknown, fallback: string): string => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 401)
			return 'Your garage session has expired. Sign in again to continue.';
		if (error.status === 409 && typeof error.error?.error === 'string')
			return error.error.error;
	}
	return fallback;
};

const online = (): boolean =>
	typeof navigator === 'undefined' || navigator.onLine;

const ownerKey = (store: { ownerSession: OwnerSessionStore }): string =>
	store.ownerSession.ownerEmail().trim().toLowerCase();

export const VoiceLogStore = signalStore(
	withState<VoiceLogState>({
		carId: '',
		localCaptures: [],
		action: null,
		error: '',
		message: '',
	}),
	withProps(({ carId }) => ({
		http: inject(HttpClient),
		queue: inject(VoiceOfflineQueue),
		ownerSession: inject(OwnerSessionStore),
		updatesResource: httpResource<VoiceListResponse>(() => {
			const id = carId();
			return id
				? {
						url: `/api/v1/cars/${encodeURIComponent(id)}/voice-updates`,
						withCredentials: true,
					}
				: undefined;
		}),
		carsResource: httpResource<{ cars: GarageCar[] }>(() => ({
			url: '/api/v1/cars',
			withCredentials: true,
		})),
	})),
	withComputed((store) => ({
		updates: computed(() =>
			store.updatesResource.hasValue()
				? store.updatesResource.value().voiceUpdates
				: [],
		),
		cars: computed(() =>
			store.carsResource.hasValue()
				? store.carsResource.value().cars.filter((car) => !car.archivedAt)
				: [],
		),
		loading: computed(() => store.updatesResource.isLoading()),
		readError: computed(() => {
			const error = store.updatesResource.error();
			return error
				? mutationMessage(
						error,
						'The voice track log could not be loaded. Check the connection and try again.',
					)
				: '';
		}),
	})),
	withMethods((store) => {
		const reloadLocal = async (): Promise<void> => {
			const captures = await store.queue.list(ownerKey(store));
			patchState(store, {
				localCaptures: captures.filter(
					(capture) => capture.carId === store.carId(),
				),
			});
		};

		const processServerCapture = async (id: string): Promise<void> => {
			try {
				await firstValueFrom(
					store.http.post(
						`/api/v1/voice-updates/${encodeURIComponent(id)}/process`,
						{},
						{ withCredentials: true },
					),
				);
			} catch {
				// The server retains the recording and exposes a retryable failed state.
			}
		};

		const upload = async (capture: PendingVoiceCapture): Promise<void> => {
			if (!online()) {
				await store.queue.updateStatus(
					capture.id,
					'queued',
					'Waiting for a connection.',
				);
				return;
			}
			await store.queue.updateStatus(capture.id, 'queued', null);
			try {
				let response: VoiceMutationResponse;
				if (capture.blob) {
					const formData = new FormData();
					formData.set('captureId', capture.id);
					if (capture.driveSessionId)
						formData.set('driveSessionId', capture.driveSessionId);
					formData.set(
						'file',
						new File([capture.blob], capture.fileName, {
							type: capture.contentType,
						}),
					);
					response = await firstValueFrom(
						store.http.post<VoiceMutationResponse>(
							`/api/v1/cars/${encodeURIComponent(capture.carId)}/voice-updates`,
							formData,
							{ withCredentials: true },
						),
					);
				} else {
					response = await firstValueFrom(
						store.http.post<VoiceMutationResponse>(
							`/api/v1/cars/${encodeURIComponent(capture.carId)}/voice-updates`,
							{
								captureId: capture.id,
								text: capture.text,
								driveSessionId: capture.driveSessionId,
							},
							{ withCredentials: true },
						),
					);
				}
				await store.queue.remove(capture.id);
				await processServerCapture(response.voiceUpdate.id);
			} catch (error) {
				await store.queue.updateStatus(
					capture.id,
					error instanceof HttpErrorResponse && error.status !== 0
						? 'failed'
						: 'queued',
					mutationMessage(
						error,
						'The recording is stored on this device and will retry when connected.',
					),
				);
			}
		};

		const mutate = async (
			action: string,
			request: () => Promise<VoiceMutationResponse>,
			fallback: string,
			message?: string,
		): Promise<VoiceMutationResponse | null> => {
			if (store.action()) return null;
			patchState(store, { action, error: '', message: '' });
			try {
				const response = await request();
				store.updatesResource.reload();
				patchState(store, {
					action: null,
					message: message ?? '',
				});
				return response;
			} catch (error) {
				store.updatesResource.reload();
				patchState(store, {
					action: null,
					error: mutationMessage(error, fallback),
				});
				return null;
			}
		};

		return {
			selectCar(carId: string): void {
				if (store.carId() !== carId) patchState(store, { carId });
				void reloadLocal();
			},
			retryRead(): void {
				store.updatesResource.reload();
			},
			clearFeedback(): void {
				patchState(store, { error: '', message: '' });
			},
			async enqueueAudio(
				blob: Blob,
				driveSessionId: string | null,
			): Promise<void> {
				const id = crypto.randomUUID();
				const capture: PendingVoiceCapture = {
					id,
					ownerKey: ownerKey(store),
					carId: store.carId(),
					driveSessionId,
					blob,
					contentType: blob.type || 'audio/webm',
					fileName: `voice-${id}.${blob.type.includes('mp4') ? 'm4a' : 'webm'}`,
					createdAt: new Date().toISOString(),
					status: 'local',
					error: null,
				};
				await store.queue.put(capture);
				await reloadLocal();
				await upload(capture);
				await reloadLocal();
				store.updatesResource.reload();
			},
			async enqueueText(
				text: string,
				driveSessionId: string | null,
			): Promise<void> {
				const id = crypto.randomUUID();
				const capture: PendingVoiceCapture = {
					id,
					ownerKey: ownerKey(store),
					carId: store.carId(),
					driveSessionId,
					text,
					contentType: 'text/plain',
					fileName: `voice-${id}.txt`,
					createdAt: new Date().toISOString(),
					status: 'local',
					error: null,
				};
				await store.queue.put(capture);
				await reloadLocal();
				await upload(capture);
				await reloadLocal();
				store.updatesResource.reload();
			},
			async retryQueued(): Promise<void> {
				if (!online()) return;
				const captures = await store.queue.list(ownerKey(store));
				for (const capture of captures) await upload(capture);
				await reloadLocal();
				store.updatesResource.reload();
			},
			async discardLocal(id: string): Promise<void> {
				await store.queue.remove(id);
				await reloadLocal();
				patchState(store, { message: 'Pending recording discarded.' });
			},
			process(id: string): Promise<VoiceMutationResponse | null> {
				return mutate(
					`process:${id}`,
					() =>
						firstValueFrom(
							store.http.post<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}/process`,
								{},
								{ withCredentials: true },
							),
						),
					'The voice note could not be processed. Try again.',
				);
			},
			correctText(
				id: string,
				text: string,
			): Promise<VoiceMutationResponse | null> {
				return mutate(
					`correct:${id}`,
					() =>
						firstValueFrom(
							store.http.post<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}/corrections`,
								{ text },
								{ withCredentials: true },
							),
						),
					'The correction could not be applied. The draft is unchanged.',
					'Draft corrected. Review the changes before saving.',
				);
			},
			correctAudio(
				id: string,
				blob: Blob,
			): Promise<VoiceMutationResponse | null> {
				const form = new FormData();
				form.set(
					'file',
					new File([blob], `correction-${id}.webm`, {
						type: blob.type || 'audio/webm',
					}),
				);
				return mutate(
					`correct:${id}`,
					() =>
						firstValueFrom(
							store.http.post<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}/corrections`,
								form,
								{ withCredentials: true },
							),
						),
					'The voice correction could not be applied. The draft is unchanged.',
					'Draft corrected. Review the changes before saving.',
				);
			},
			confirm(
				id: string,
				acceptUnresolvedAsNotes: boolean,
			): Promise<VoiceMutationResponse | null> {
				return mutate(
					`confirm:${id}`,
					() =>
						firstValueFrom(
							store.http.post<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}/confirm`,
								{ acceptUnresolvedAsNotes },
								{ withCredentials: true },
							),
						),
					'The voice update could not be saved. Review it and try again.',
					'Voice update saved to garage history.',
				);
			},
			updateContext(
				id: string,
				carId: string,
				driveSessionId: string | null,
			): Promise<VoiceMutationResponse | null> {
				return mutate(
					`context:${id}`,
					() =>
						firstValueFrom(
							store.http.patch<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}`,
								{ carId, driveSessionId },
								{ withCredentials: true },
							),
						),
					'The recording context could not be changed.',
					'Recording context updated.',
				);
			},
			discardServer(
				id: string,
				saved: boolean,
			): Promise<VoiceMutationResponse | null> {
				return mutate(
					`discard:${id}`,
					() =>
						firstValueFrom(
							store.http.delete<VoiceMutationResponse>(
								`/api/v1/voice-updates/${encodeURIComponent(id)}`,
								{ withCredentials: true },
							),
						),
					'The recording could not be removed.',
					saved
						? 'Original audio removed. Saved garage history was retained.'
						: 'Pending recording discarded.',
				);
			},
		};
	}),
);
