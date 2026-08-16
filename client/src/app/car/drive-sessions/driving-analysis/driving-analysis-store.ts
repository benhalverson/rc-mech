import { computed, inject } from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import {
	catchError,
	concatMap,
	EMPTY,
	endWith,
	exhaustMap,
	from,
	ignoreElements,
	Subject,
	switchMap,
	takeUntil,
	tap,
} from 'rxjs';
import {
	idleRaceRecordingTransfer,
	type RaceRecordingGatewayFailure,
	type RaceRecordingIdentity,
	type RaceRecordingTransferState,
	type StartRaceRecordingCommand,
} from './race-recording.models';
import { RaceRecordingFileCapability } from './race-recording-file';
import { RaceRecordingGateway } from './race-recording-gateway';

type RaceRecordingState = {
	carId: string;
	transfer: RaceRecordingTransferState;
	removal: RaceRecordingRemovalState;
};

type RaceRecordingRemovalState = Readonly<{
	status: 'idle' | 'removing' | 'failed';
	driveSessionId: string | null;
	recordingId: string | null;
	error: RaceRecordingGatewayFailure | null;
}>;

const idleRaceRecordingRemoval = (): RaceRecordingRemovalState => ({
	status: 'idle',
	driveSessionId: null,
	recordingId: null,
	error: null,
});

const failureMessage = (failure: RaceRecordingGatewayFailure): string => {
	if (failure.kind === 'file-required')
		return 'Choose the same Race-recording file to resume this upload.';
	if ('status' in failure && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	if (failure.kind === 'rejected-response') return failure.message;
	return 'The Race recording could not be uploaded.';
};

const removalFailureMessage = (
	failure: RaceRecordingGatewayFailure,
): string => {
	if ('status' in failure && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	if (failure.kind === 'rejected-response') return failure.message;
	return 'The Race recording could not be removed.';
};

const transferState = (
	status: RaceRecordingTransferState['status'],
	driveSessionId: string,
	recordingId: string | null,
	uploadedBytes: number,
	totalBytes: number,
	error: RaceRecordingGatewayFailure | null = null,
): RaceRecordingTransferState => ({
	status,
	driveSessionId,
	recordingId,
	uploadedBytes,
	totalBytes,
	error,
});

export const DrivingAnalysisStore = signalStore(
	withState<RaceRecordingState>({
		carId: '',
		transfer: idleRaceRecordingTransfer(),
		removal: idleRaceRecordingRemoval(),
	}),
	withProps(() => ({
		gateway: inject(RaceRecordingGateway),
		files: inject(RaceRecordingFileCapability),
		stopTransfer: new Subject<void>(),
	})),
	withComputed((store) => ({
		recordings: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value()
				: [],
		),
		loading: computed(() => store.gateway.collection.isLoading()),
		readFailure: computed(() => store.gateway.collectionFailure()),
		pending: computed(
			() =>
				['uploading', 'cancelling'].includes(store.transfer().status) ||
				store.removal().status === 'removing',
		),
		removalPending: computed(() => store.removal().status === 'removing'),
		error: computed(() => {
			const error = store.transfer().error;
			return error ? failureMessage(error) : '';
		}),
		removalError: computed(() => {
			const error = store.removal().error;
			return error ? removalFailureMessage(error) : '';
		}),
	})),
	withMethods((store) => {
		const upload = rxMethod<StartRaceRecordingCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const requestId = store.files.requestId(command.driveSessionId);
					if (!requestId) {
						patchState(store, {
							transfer: transferState(
								'failed',
								command.driveSessionId,
								null,
								0,
								command.file.size,
								{ kind: 'file-required' },
							),
						});
						return EMPTY;
					}
					patchState(store, {
						transfer: transferState(
							'uploading',
							command.driveSessionId,
							null,
							0,
							command.file.size,
						),
					});
					return store.gateway
						.createUpload({
							carId: command.carId,
							driveSessionId: command.driveSessionId,
							fileName: command.file.name,
							contentType: command.file.type,
							sizeBytes: command.file.size,
							requestId,
						})
						.pipe(
							switchMap((recording) => {
								if (
									recording.carId !== command.carId ||
									recording.driveSessionId !== command.driveSessionId ||
									recording.fileName !== command.file.name ||
									recording.contentType !== command.file.type ||
									recording.sizeBytes !== command.file.size
								)
									throw {
										kind: 'rejected-response',
										status: 409,
										message:
											'Choose the same Race-recording file to resume this upload.',
									} satisfies RaceRecordingGatewayFailure;
								patchState(store, {
									transfer: transferState(
										'uploading',
										command.driveSessionId,
										recording.id,
										recording.uploadedBytes,
										recording.sizeBytes,
									),
								});
								const completed = new Set(recording.uploadedPartNumbers);
								const count = Math.ceil(
									recording.sizeBytes / recording.partSizeBytes,
								);
								const missing = Array.from(
									{ length: count },
									(_value, index) => index + 1,
								).filter((partNumber) => !completed.has(partNumber));
								let confirmedBytes = recording.uploadedBytes;
								return from(missing).pipe(
									concatMap((partNumber) => {
										const start = (partNumber - 1) * recording.partSizeBytes;
										const bytes = store.files.part(
											command.driveSessionId,
											start,
											Math.min(
												start + recording.partSizeBytes,
												recording.sizeBytes,
											),
										);
										if (!bytes)
											throw {
												kind: 'file-required',
											} satisfies RaceRecordingGatewayFailure;
										return store.gateway
											.uploadPart({
												carId: command.carId,
												driveSessionId: command.driveSessionId,
												recordingId: recording.id,
												partNumber,
												transferRequestId: `${recording.id}:part:${partNumber}`,
												bytes,
											})
											.pipe(
												tap((event) => {
													if (event.kind === 'completed')
														confirmedBytes = event.recording.uploadedBytes;
													patchState(store, {
														transfer: transferState(
															'uploading',
															command.driveSessionId,
															recording.id,
															event.kind === 'completed'
																? event.recording.uploadedBytes
																: Math.min(
																		recording.sizeBytes,
																		confirmedBytes + event.loaded,
																	),
															recording.sizeBytes,
														),
													});
												}),
											);
									}),
									ignoreElements(),
									endWith(recording),
									switchMap(() =>
										store.gateway.completeUpload({
											carId: command.carId,
											driveSessionId: command.driveSessionId,
											recordingId: recording.id,
										}),
									),
								);
							}),
							takeUntil(store.stopTransfer),
							tap((recording) => {
								if (recording.status !== 'validating')
									throw {
										kind: 'rejected-response',
										status: 409,
										message:
											'Race recording completion was not confirmed by the server.',
									} satisfies RaceRecordingGatewayFailure;
								store.files.forget(command.driveSessionId);
								store.gateway.refresh();
								patchState(store, {
									transfer: transferState(
										'complete',
										command.driveSessionId,
										recording.id,
										recording.sizeBytes,
										recording.sizeBytes,
									),
								});
							}),
							catchError((error: RaceRecordingGatewayFailure) => {
								patchState(store, {
									transfer: {
										...store.transfer(),
										status: 'failed',
										error,
									},
								});
								return EMPTY;
							}),
						);
				}),
			),
		);

		const remove = rxMethod<RaceRecordingIdentity>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					if (!command.carId || command.carId !== store.carId()) return EMPTY;
					const active = store.transfer();
					const ownsTransfer =
						active.driveSessionId === command.driveSessionId &&
						active.recordingId === command.recordingId;
					if (ownsTransfer && active.status === 'uploading') {
						store.stopTransfer.next();
						patchState(store, {
							transfer: { ...active, status: 'paused' },
						});
					}
					patchState(store, {
						removal: {
							status: 'removing',
							driveSessionId: command.driveSessionId,
							recordingId: command.recordingId,
							error: null,
						},
					});
					return store.gateway.deleteRecording(command).pipe(
						tap(() => {
							store.files.forget(command.driveSessionId);
							store.gateway.refresh();
							const current = store.transfer();
							patchState(store, {
								removal: idleRaceRecordingRemoval(),
								...(current.driveSessionId === command.driveSessionId &&
								current.recordingId === command.recordingId
									? { transfer: idleRaceRecordingTransfer() }
									: {}),
							});
						}),
						catchError((error: RaceRecordingGatewayFailure) => {
							patchState(store, {
								removal: {
									status: 'failed',
									driveSessionId: command.driveSessionId,
									recordingId: command.recordingId,
									error,
								},
							});
							return EMPTY;
						}),
					);
				}),
			),
		);

		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				store.stopTransfer.next();
				store.files.clear();
				patchState(store, {
					carId,
					transfer: idleRaceRecordingTransfer(),
					removal: idleRaceRecordingRemoval(),
				});
				store.gateway.selectCar(carId);
			},
			startUpload(command: StartRaceRecordingCommand): void {
				if (!command.carId || command.carId !== store.carId()) return;
				store.files.remember(command.driveSessionId, command.file);
				upload(command);
			},
			pauseUpload(driveSessionId: string): void {
				const active = store.transfer();
				if (
					active.status !== 'uploading' ||
					active.driveSessionId !== driveSessionId
				)
					return;
				store.stopTransfer.next();
				patchState(store, {
					transfer: { ...active, status: 'paused' },
				});
			},
			resumeUpload(driveSessionId: string): void {
				const file = store.files.file(driveSessionId);
				if (!file) {
					patchState(store, {
						transfer: {
							...store.transfer(),
							status: 'failed',
							driveSessionId,
							error: { kind: 'file-required' },
						},
					});
					return;
				}
				upload({ carId: store.carId(), driveSessionId, file });
			},
			removeRecording(command: RaceRecordingIdentity): void {
				remove(command);
			},
			hasSelectedFile(driveSessionId: string): boolean {
				return store.files.file(driveSessionId) !== null;
			},
			selectedFileName(driveSessionId: string): string {
				return store.files.file(driveSessionId)?.name ?? '';
			},
			retry(): void {
				store.gateway.refresh();
			},
		};
	}),
);
