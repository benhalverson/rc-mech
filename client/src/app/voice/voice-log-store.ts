import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { firstValueFrom, type Observable } from 'rxjs';
import { OwnerSessionStore } from '../owner-session-store';
import { VoiceConnectivity } from './voice-connectivity';
import { VoiceGateway } from './voice-gateway';
import type {
	CaptureTextCommand,
	CorrectVoiceTextCommand,
	PendingVoiceCapture,
	StopRecordingCommand,
	UpdateVoiceContextCommand,
	VoiceGatewayFailure,
	VoiceMutationResponse,
	VoiceOperation,
	VoiceOperationOutcome,
	VoiceRecordingMode,
	VoiceUpdate,
	VoiceWorkflowFailure,
} from './voice.models';
import { VoiceOfflineQueue } from './voice-offline-queue';
import { VoiceRecorder } from './voice-recorder';

type VoiceLogState = {
	readonly carId: string;
	readonly localCaptures: PendingVoiceCapture[];
	readonly optimisticUpdates: VoiceUpdate[];
	readonly recordingMode: VoiceRecordingMode | null;
	readonly recorderError: string;
	readonly message: string;
	readonly outcome: VoiceOperationOutcome;
};

type CaptureUploadResult =
	| { readonly kind: 'queued' }
	| { readonly kind: 'review-ready'; readonly response: VoiceMutationResponse }
	| { readonly kind: 'rejected'; readonly failure: VoiceGatewayFailure }
	| {
			readonly kind: 'processing-failed';
			readonly failure: VoiceWorkflowFailure;
	  };

const idleOutcome = (): VoiceOperationOutcome => ({
	status: 'idle',
	operation: null,
	operationId: null,
});

const isGatewayFailure = (error: unknown): error is VoiceGatewayFailure =>
	Boolean(
		error &&
			typeof error === 'object' &&
			'kind' in error &&
			['http', 'rejected-response', 'unavailable', 'invalid-response'].includes(
				String(error.kind),
			),
	);

const recordingMessage = (error: unknown): string => {
	if (error instanceof DOMException && error.name === 'NotAllowedError')
		return 'Microphone access was denied. Allow it in browser settings or use the text note fallback.';
	return error instanceof Error
		? error.message
		: 'The microphone could not be started.';
};

const workflowFailure = (
	error: unknown,
	fallback: string,
): VoiceWorkflowFailure => {
	if (isGatewayFailure(error)) return error;
	return {
		kind: 'local-storage',
		message: error instanceof Error ? error.message : fallback,
	};
};

const failureMessage = (
	failure: VoiceWorkflowFailure,
	operation: VoiceOperation,
): string => {
	if (
		failure.kind === 'invalid-command' ||
		failure.kind === 'recording' ||
		failure.kind === 'processing'
	)
		return failure.message;
	if (failure.kind === 'local-storage')
		return operation === 'discard-local'
			? 'The pending recording could not be discarded from this device.'
			: 'The recording could not be stored safely on this device.';
	if ('status' in failure && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	if (failure.kind === 'rejected-response') return failure.message;
	if (failure.kind === 'invalid-response')
		return 'The voice service returned an invalid response. Nothing was applied.';
	switch (operation) {
		case 'process':
			return 'The voice note could not be processed. Try again.';
		case 'correct-text':
			return 'The correction could not be applied. The draft is unchanged.';
		case 'correct-audio':
			return 'The voice correction could not be applied. The draft is unchanged.';
		case 'confirm':
			return 'The voice update could not be saved. Review it and try again.';
		case 'update-context':
			return 'The recording context could not be changed.';
		case 'discard-server':
			return 'The recording could not be removed.';
		default:
			return 'The recording is stored on this device and will retry when connected.';
	}
};

const successMessage = (
	operation: VoiceOperation,
	response: VoiceMutationResponse | null,
	saved = false,
): string => {
	switch (operation) {
		case 'capture-audio':
		case 'capture-text':
			if (!response)
				return 'Voice note stored on this device and queued for upload.';
			return response.voiceUpdate.status === 'needs-review'
				? 'Voice note ready for review.'
				: 'Voice note uploaded and processing.';
		case 'retry-queued':
			return 'Pending voice notes checked for upload.';
		case 'discard-local':
			return 'Pending recording discarded.';
		case 'correct-text':
			return response?.correction?.outcome === 'manual-note'
				? 'Correction saved as a free-form note. Review it before saving.'
				: 'Draft corrected. Review the changes before saving.';
		case 'correct-audio':
			return 'Draft corrected. Review the changes before saving.';
		case 'confirm':
			return 'Voice update saved to garage history.';
		case 'update-context':
			return 'Recording context updated.';
		case 'discard-server':
			return saved
				? 'Original audio removed. Saved garage history was retained.'
				: 'Pending recording discarded.';
		default:
			return '';
	}
};

export const VoiceLogStore = signalStore(
	withState<VoiceLogState>({
		carId: '',
		localCaptures: [],
		optimisticUpdates: [],
		recordingMode: null,
		recorderError: '',
		message: '',
		outcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(VoiceGateway),
		queue: inject(VoiceOfflineQueue),
		connectivity: inject(VoiceConnectivity),
		ownerSession: inject(OwnerSessionStore),
		recorder: inject(VoiceRecorder),
		nextOperationId: { value: 0 },
		selectionGeneration: { value: 0 },
	})),
	withComputed((store) => ({
		updates: computed<readonly VoiceUpdate[]>(() => {
			const remote = store.gateway.updates.hasValue()
				? store.gateway.updates
						.value()
						.filter((update) => update.carId === store.carId())
				: [];
			const remoteById = new Map(remote.map((update) => [update.id, update]));
			const optimistic = store.optimisticUpdates().filter((update) => {
				if (update.carId !== store.carId()) return false;
				const matchingRemote = remoteById.get(update.id);
				return !matchingRemote || matchingRemote.updatedAt <= update.updatedAt;
			});
			const optimisticIds = new Set(optimistic.map((update) => update.id));
			return [
				...optimistic,
				...remote.filter((update) => !optimisticIds.has(update.id)),
			];
		}),
		cars: computed(() =>
			store.gateway.contextCars.hasValue()
				? store.gateway.contextCars.value()
				: [],
		),
		loading: computed(() => store.gateway.updates.isLoading()),
		readError: computed(() => {
			const failure = store.gateway.updatesFailure();
			if (!failure) return '';
			if ('status' in failure && failure.status === 401)
				return 'Your garage session has expired. Sign in again to continue.';
			if (failure.kind === 'invalid-response')
				return 'The voice history response was invalid. Try again.';
			return 'The voice track log could not be loaded. Check the connection and try again.';
		}),
		pending: computed(() => store.outcome().status === 'pending'),
		action: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'pending'
				? `${outcome.operation}:${outcome.subjectId ?? ''}`
				: null;
		}),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? failureMessage(outcome.error, outcome.operation)
				: '';
		}),
		checking: computed(() => store.recorder.checking()),
		supported: computed(() => store.recorder.supported()),
		starting: computed(() => store.recorder.starting()),
		recording: computed(() => store.recorder.recording()),
		elapsedSeconds: computed(() => store.recorder.elapsedSeconds()),
		inputLevel: computed(() => store.recorder.inputLevel()),
		audioDetected: computed(() => store.recorder.audioDetected()),
		inputMuted: computed(() => store.recorder.inputMuted()),
	})),
	withMethods((store) => {
		const ownerKey = (): string =>
			store.ownerSession.ownerEmail().trim().toLowerCase();

		const active = (carId: string, generation: number): boolean =>
			store.carId() === carId && store.selectionGeneration.value === generation;

		const reloadLocal = async (
			carId = store.carId(),
			generation = store.selectionGeneration.value,
		): Promise<void> => {
			const captures = await store.queue.list(ownerKey());
			if (!active(carId, generation)) return;
			patchState(store, {
				localCaptures: captures.filter((capture) => capture.carId === carId),
			});
		};

		const begin = (
			operation: VoiceOperation,
			subjectId: string | null,
		): number | null => {
			if (store.outcome().status === 'pending') return null;
			const operationId = ++store.nextOperationId.value;
			patchState(store, {
				recorderError: '',
				message: '',
				outcome: { status: 'pending', operation, operationId, subjectId },
			});
			return operationId;
		};

		const succeed = (
			operation: VoiceOperation,
			operationId: number,
			subjectId: string | null,
			response: VoiceMutationResponse | null,
			destinationCarId: string | null = null,
			saved = false,
		): void => {
			const update = response?.voiceUpdate ?? null;
			const optimisticUpdates = update
				? [
						update,
						...store
							.optimisticUpdates()
							.filter((candidate) => candidate.id !== update.id),
					]
				: store.optimisticUpdates();
			patchState(store, {
				optimisticUpdates,
				message: successMessage(operation, response, saved),
				outcome: {
					status: 'succeeded',
					operation,
					operationId,
					subjectId,
					update,
					destinationCarId,
				},
			});
		};

		const fail = (
			operation: VoiceOperation,
			operationId: number,
			subjectId: string | null,
			error: VoiceWorkflowFailure,
		): void => {
			patchState(store, {
				outcome: { status: 'failed', operation, operationId, subjectId, error },
			});
		};

		const capture = (
			id: string,
			driveSessionId: string | null,
			value: { readonly blob: Blob } | { readonly text: string },
		): PendingVoiceCapture => {
			const common = {
				id,
				ownerKey: ownerKey(),
				carId: store.carId(),
				driveSessionId,
				createdAt: new Date().toISOString(),
				status: 'local' as const,
				error: null,
			};
			if ('blob' in value) {
				const contentType = value.blob.type || 'audio/webm';
				return {
					...common,
					blob: value.blob,
					contentType,
					fileName: `voice-${id}.${contentType.includes('mp4') ? 'm4a' : 'webm'}`,
				};
			}
			return {
				...common,
				text: value.text,
				contentType: 'text/plain',
				fileName: `voice-${id}.txt`,
			};
		};

		const upload = async (
			pendingCapture: PendingVoiceCapture,
		): Promise<CaptureUploadResult> => {
			if (!store.connectivity.isOnline()) {
				await store.queue.updateStatus(
					pendingCapture.id,
					'queued',
					'Waiting for a connection.',
				);
				return { kind: 'queued' };
			}
			await store.queue.updateStatus(pendingCapture.id, 'queued', null);
			try {
				const response = await firstValueFrom(
					store.gateway.upload(pendingCapture),
				);
				await store.queue.remove(pendingCapture.id);
				try {
					const processed = await firstValueFrom(
						store.gateway.process(response.voiceUpdate.id),
					);
					return { kind: 'review-ready', response: processed };
				} catch (error) {
					// The server retains the recording and exposes a retryable failed state.
					return {
						kind: 'processing-failed',
						failure: {
							kind: 'processing',
							message: isGatewayFailure(error)
								? failureMessage(error, 'process')
								: 'The voice note could not be processed. Try again.',
						},
					};
				}
			} catch (error) {
				const failure = isGatewayFailure(error)
					? error
					: ({ kind: 'unavailable' } as const);
				await store.queue.updateStatus(
					pendingCapture.id,
					failure.kind === 'unavailable' ? 'queued' : 'failed',
					failureMessage(failure, 'capture-audio'),
				);
				return failure.kind === 'unavailable'
					? { kind: 'queued' }
					: { kind: 'rejected', failure };
			}
		};

		const saveCapture = async (
			operation: 'capture-audio' | 'capture-text',
			operationId: number,
			pendingCapture: PendingVoiceCapture,
			generation: number,
		): Promise<void> => {
			try {
				await store.queue.put(pendingCapture);
				await reloadLocal(pendingCapture.carId, generation);
				const result = await upload(pendingCapture);
				await reloadLocal(pendingCapture.carId, generation);
				if (!active(pendingCapture.carId, generation)) return;
				store.gateway.refresh();
				if (result.kind === 'rejected' || result.kind === 'processing-failed') {
					fail(operation, operationId, pendingCapture.id, result.failure);
					return;
				}
				succeed(
					operation,
					operationId,
					pendingCapture.id,
					result.kind === 'review-ready' ? result.response : null,
				);
			} catch (error) {
				if (!active(pendingCapture.carId, generation)) return;
				fail(
					operation,
					operationId,
					pendingCapture.id,
					workflowFailure(error, 'The recording could not be stored.'),
				);
			}
		};

		const mutate = (
			operation: Exclude<
				VoiceOperation,
				| 'start-recording'
				| 'capture-audio'
				| 'capture-text'
				| 'retry-queued'
				| 'discard-local'
			>,
			subjectId: string,
			request: () => Observable<VoiceMutationResponse>,
			options: {
				readonly destinationCarId?: string;
				readonly saved?: boolean;
			} = {},
		): void => {
			const operationId = begin(operation, subjectId);
			if (operationId === null) return;
			const carId = store.carId();
			const generation = store.selectionGeneration.value;
			void firstValueFrom(request()).then(
				(response) => {
					if (!active(carId, generation)) return;
					store.gateway.refresh();
					succeed(
						operation,
						operationId,
						subjectId,
						response,
						options.destinationCarId ?? null,
						options.saved,
					);
				},
				(error: unknown) => {
					if (!active(carId, generation)) return;
					store.gateway.refresh();
					fail(
						operation,
						operationId,
						subjectId,
						workflowFailure(error, 'The voice operation failed.'),
					);
				},
			);
		};

		const runQueuedRetry = async (
			operationId: number,
			carId: string,
			generation: number,
			captures?: readonly PendingVoiceCapture[],
		): Promise<void> => {
			try {
				const pendingCaptures =
					captures ?? (await store.queue.list(ownerKey()));
				if (!active(carId, generation)) return;
				let failure: VoiceWorkflowFailure | null = null;
				for (const pendingCapture of pendingCaptures) {
					const result = await upload(pendingCapture);
					if (result.kind === 'rejected' || result.kind === 'processing-failed')
						failure ??= result.failure;
				}
				await reloadLocal(carId, generation);
				if (!active(carId, generation)) return;
				store.gateway.refresh();
				if (failure) fail('retry-queued', operationId, null, failure);
				else succeed('retry-queued', operationId, null, null);
			} catch (error) {
				if (!active(carId, generation)) return;
				fail(
					'retry-queued',
					operationId,
					null,
					workflowFailure(error, 'The pending notes could not be read.'),
				);
			}
		};

		const loadLocalAndRetry = (carId: string, generation: number): void => {
			void store.queue.list(ownerKey()).then(
				(captures) => {
					if (!active(carId, generation)) return;
					patchState(store, {
						localCaptures: captures.filter(
							(capture) => capture.carId === carId,
						),
					});
					if (!captures.length || !store.connectivity.isOnline()) return;
					const operationId = begin('retry-queued', null);
					if (operationId !== null)
						void runQueuedRetry(operationId, carId, generation, captures);
				},
				(error: unknown) => {
					if (!active(carId, generation)) return;
					const operationId = begin('retry-queued', null);
					if (operationId !== null)
						fail(
							'retry-queued',
							operationId,
							null,
							workflowFailure(error, 'The pending notes could not be read.'),
						);
				},
			);
		};

		return {
			selectCar(carId: string): void {
				if (!carId || store.carId() === carId) return;
				store.recorder.cancel();
				store.selectionGeneration.value += 1;
				patchState(store, {
					carId,
					localCaptures: [],
					optimisticUpdates: [],
					recordingMode: null,
					recorderError: '',
					message: '',
					outcome: idleOutcome(),
				});
				store.gateway.selectCar(carId);
				loadLocalAndRetry(carId, store.selectionGeneration.value);
			},
			detectRecorderSupport(): void {
				void store.recorder.detectSupport();
			},
			startRecording(mode: VoiceRecordingMode): void {
				if (store.recordingMode()) return;
				const operationId = begin(
					'start-recording',
					mode.kind === 'correction' ? mode.id : null,
				);
				if (operationId === null) return;
				const carId = store.carId();
				const generation = store.selectionGeneration.value;
				patchState(store, { recordingMode: mode });
				void store.recorder.start().then(
					() => {
						if (!active(carId, generation)) return;
						succeed(
							'start-recording',
							operationId,
							mode.kind === 'correction' ? mode.id : null,
							null,
						);
					},
					(error: unknown) => {
						if (!active(carId, generation)) return;
						const message = recordingMessage(error);
						patchState(store, { recordingMode: null, recorderError: message });
						fail(
							'start-recording',
							operationId,
							mode.kind === 'correction' ? mode.id : null,
							{ kind: 'recording', message },
						);
					},
				);
			},
			stopRecording(command: StopRecordingCommand): void {
				const mode = store.recordingMode();
				if (!mode || store.recorder.starting()) return;
				const operation =
					mode.kind === 'capture' ? 'capture-audio' : 'correct-audio';
				const subjectId = mode.kind === 'correction' ? mode.id : null;
				const operationId = begin(operation, subjectId);
				if (operationId === null) return;
				const carId = store.carId();
				const generation = store.selectionGeneration.value;
				void store.recorder.stop().then(
					(blob) => {
						if (!active(carId, generation)) return;
						patchState(store, { recordingMode: null });
						if (mode.kind === 'capture') {
							const id = store.queue.createId();
							void saveCapture(
								'capture-audio',
								operationId,
								capture(id, command.driveSessionId, { blob }),
								generation,
							);
							return;
						}
						void firstValueFrom(store.gateway.correctAudio(mode.id, blob)).then(
							(response) => {
								if (!active(carId, generation)) return;
								store.gateway.refresh();
								succeed('correct-audio', operationId, mode.id, response);
							},
							(error: unknown) => {
								if (!active(carId, generation)) return;
								fail(
									'correct-audio',
									operationId,
									mode.id,
									workflowFailure(error, 'The correction failed.'),
								);
							},
						);
					},
					(error: unknown) => {
						if (!active(carId, generation)) return;
						const message = recordingMessage(error);
						patchState(store, { recordingMode: null, recorderError: message });
						fail(operation, operationId, subjectId, {
							kind: 'recording',
							message,
						});
					},
				);
			},
			cancelRecording(): void {
				store.recorder.cancel();
				patchState(store, {
					recordingMode: null,
					recorderError: 'Recording cancelled. Nothing was saved.',
					outcome: idleOutcome(),
				});
			},
			captureText(command: CaptureTextCommand): void {
				const text = command.text.trim();
				const operationId = begin('capture-text', null);
				if (operationId === null) return;
				if (!text) {
					const message = 'Describe the track note before saving it.';
					patchState(store, { recorderError: message });
					fail('capture-text', operationId, null, {
						kind: 'invalid-command',
						message,
					});
					return;
				}
				const id = store.queue.createId();
				void saveCapture(
					'capture-text',
					operationId,
					capture(id, command.driveSessionId, { text }),
					store.selectionGeneration.value,
				);
			},
			retryQueued(): void {
				if (!store.connectivity.isOnline()) return;
				const operationId = begin('retry-queued', null);
				if (operationId === null) return;
				const carId = store.carId();
				const generation = store.selectionGeneration.value;
				void runQueuedRetry(operationId, carId, generation);
			},
			discardLocal(id: string): void {
				const operationId = begin('discard-local', id);
				if (operationId === null) return;
				const carId = store.carId();
				const generation = store.selectionGeneration.value;
				void (async () => {
					try {
						await store.queue.remove(id);
						await reloadLocal(carId, generation);
						if (active(carId, generation))
							succeed('discard-local', operationId, id, null);
					} catch (error) {
						if (!active(carId, generation)) return;
						fail(
							'discard-local',
							operationId,
							id,
							workflowFailure(error, 'The recording could not be discarded.'),
						);
					}
				})();
			},
			process(id: string): void {
				mutate('process', id, () => store.gateway.process(id));
			},
			correctText(command: CorrectVoiceTextCommand): void {
				const text = command.text.trim();
				if (!text) {
					const operationId = begin('correct-text', command.id);
					if (operationId !== null)
						fail('correct-text', operationId, command.id, {
							kind: 'invalid-command',
							message: 'Say or type the correction first.',
						});
					return;
				}
				mutate('correct-text', command.id, () =>
					store.gateway.correctText(command.id, text),
				);
			},
			confirm(id: string, acceptUnresolvedAsNotes: boolean): void {
				mutate('confirm', id, () =>
					store.gateway.confirm(id, acceptUnresolvedAsNotes),
				);
			},
			updateContext(command: UpdateVoiceContextCommand): void {
				mutate(
					'update-context',
					command.id,
					() =>
						store.gateway.updateContext(
							command.id,
							command.carId,
							command.driveSessionId,
						),
					{ destinationCarId: command.carId },
				);
			},
			discardServer(id: string, saved: boolean): void {
				mutate('discard-server', id, () => store.gateway.discard(id), {
					saved,
				});
			},
			retryRead(): void {
				store.gateway.refresh();
			},
			clearFeedback(): void {
				if (store.outcome().status !== 'pending')
					patchState(store, {
						recorderError: '',
						message: '',
						outcome: idleOutcome(),
					});
			},
		};
	}),
);
