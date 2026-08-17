import { computed, effect, inject } from '@angular/core';
import { toObservable } from '@angular/core/rxjs-interop';
import {
	patchState,
	signalStore,
	withComputed,
	withHooks,
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
	timer,
} from 'rxjs';
import {
	TrackMapGateway,
	trackMapGatewayFailure,
} from '../../../track-maps/track-map-gateway';
import {
	type CreateDrivingAnalysisCommand,
	type DrivingAnalysis,
	type DrivingAnalysisGatewayFailure,
	type StartDrivingAnalysisCommand,
} from './driving-analysis.models';
import { DrivingAnalysisGateway } from './driving-analysis-gateway';
import { DrivingAnalysisRequestIdentityCapability } from './driving-analysis-request-identity';
import { PageVisibilityCapability } from './page-visibility';
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
	analysisCreation: DrivingAnalysisCreationState;
};

type DrivingAnalysisCreationState = Readonly<{
	status: 'idle' | 'creating' | 'accepted' | 'failed';
	driveSessionId: string | null;
	analysis: DrivingAnalysis | null;
	error: DrivingAnalysisGatewayFailure | null;
}>;

export type ApprovedTrackMapOption = Readonly<{
	id: string;
	layoutId: string;
	layoutName: string;
	version: number;
	approvedAt: string | null;
}>;

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

const idleDrivingAnalysisCreation = (): DrivingAnalysisCreationState => ({
	status: 'idle',
	driveSessionId: null,
	analysis: null,
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

const analysisFailureMessage = (
	failure: DrivingAnalysisGatewayFailure,
): string => {
	if ('status' in failure && failure.status === 401)
		return 'Your garage session has expired. Sign in again to continue.';
	if (failure.kind === 'rejected-response') return failure.message;
	return 'The Driving analysis could not be started.';
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
		analysisCreation: idleDrivingAnalysisCreation(),
	}),
	withProps(() => {
		const visibility = inject(PageVisibilityCapability);
		return {
			gateway: inject(RaceRecordingGateway),
			analyses: inject(DrivingAnalysisGateway),
			analysisRequests: inject(DrivingAnalysisRequestIdentityCapability),
			trackMaps: inject(TrackMapGateway),
			files: inject(RaceRecordingFileCapability),
			visibility,
			visibilityChanges: toObservable(visibility.hidden),
			stopTransfer: new Subject<void>(),
		};
	}),
	withComputed((store) => ({
		recordings: computed(() =>
			store.gateway.collection.hasValue()
				? store.gateway.collection.value()
				: [],
		),
		loading: computed(() => store.gateway.collection.isLoading()),
		readFailure: computed(() => store.gateway.collectionFailure()),
		approvedTrackMaps: computed<readonly ApprovedTrackMapOption[]>(() => {
			if (!store.trackMaps.layouts.hasValue()) return [];
			return store.trackMaps.layouts
				.value()
				.trackLayouts.filter((layout) => layout.status === 'active')
				.flatMap((layout) =>
					layout.mapVersions
						.filter((version) => version.status === 'approved')
						.map((version) => ({
							id: version.id,
							layoutId: layout.id,
							layoutName: layout.name,
							version: version.version,
							approvedAt: version.approvedAt,
						})),
				);
		}),
		trackMapsLoading: computed(() => store.trackMaps.layouts.isLoading()),
		trackMapsFailure: computed(() => {
			const error = store.trackMaps.layouts.error();
			return error ? trackMapGatewayFailure(error) : null;
		}),
		selectedTrackMap: computed(() =>
			store.trackMaps.version.hasValue()
				? store.trackMaps.version.value()
				: null,
		),
		selectedTrackMapLoading: computed(() =>
			store.trackMaps.version.isLoading(),
		),
		analysis: computed(() => store.analysisCreation().analysis),
		pending: computed(
			() =>
				['uploading', 'cancelling'].includes(store.transfer().status) ||
				store.removal().status === 'removing' ||
				store.analysisCreation().status === 'creating',
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
		analysisError: computed(() => {
			const error = store.analysisCreation().error;
			return error ? analysisFailureMessage(error) : '';
		}),
	})),
	withHooks({
		onInit(store) {
			effect(() => {
				if (store.analyses.analysis.hasValue()) {
					const analysis = store.analyses.analysis.value();
					const current = store.analysisCreation();
					if (
						current.status === 'accepted' &&
						current.analysis?.id === analysis.id &&
						current.analysis.stateVersion === analysis.stateVersion
					)
						return;
					patchState(store, {
						analysisCreation: {
							status: 'accepted',
							driveSessionId: analysis.driveSessionId,
							analysis,
							error: null,
						},
					});
					return;
				}
				const failure = store.analyses.analysisFailure();
				const current = store.analysisCreation();
				if (
					failure &&
					current.analysis &&
					(current.status !== 'failed' || current.error !== failure)
				)
					patchState(store, {
						analysisCreation: {
							...current,
							status: 'failed',
							error: failure,
						},
					});
			});
		},
	}),
	withMethods((store) => {
		const monitorAnalysis = rxMethod<string>((analysisIds$) =>
			analysisIds$.pipe(
				switchMap(() =>
					store.visibilityChanges.pipe(
						switchMap((hidden) => {
							const interval = hidden ? 30_000 : 3_000;
							return timer(interval, interval);
						}),
						tap(() => {
							const analysis = store.analysisCreation().analysis;
							if (
								analysis &&
								![
									'completed',
									'failed',
									'cancelled',
									'deleting',
									'deleted',
								].includes(analysis.status)
							)
								store.analyses.refresh();
						}),
					),
				),
			),
		);
		const createAnalysis = rxMethod<CreateDrivingAnalysisCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					if (!command.carId || command.carId !== store.carId()) return EMPTY;
					patchState(store, {
						analysisCreation: {
							status: 'creating',
							driveSessionId: command.driveSessionId,
							analysis: null,
							error: null,
						},
					});
					return store.analyses.create(command).pipe(
						tap((analysis) => {
							patchState(store, {
								analysisCreation: {
									status: 'accepted',
									driveSessionId: command.driveSessionId,
									analysis,
									error: null,
								},
							});
							store.analyses.selectAnalysis(analysis.id);
							monitorAnalysis(analysis.id);
						}),
						catchError((error: DrivingAnalysisGatewayFailure) => {
							patchState(store, {
								analysisCreation: {
									status: 'failed',
									driveSessionId: command.driveSessionId,
									analysis: null,
									error,
								},
							});
							return EMPTY;
						}),
					);
				}),
			),
		);
		const monitorValidation = rxMethod<string>((carIds$) =>
			carIds$.pipe(
				switchMap(() =>
					store.visibilityChanges.pipe(
						switchMap((hidden) => {
							const interval = hidden ? 30_000 : 3_000;
							return timer(interval, interval);
						}),
						tap(() => {
							if (
								store.gateway.collection.hasValue() &&
								store.gateway.collection
									.value()
									.some((recording) => recording.status === 'validating')
							)
								store.gateway.refresh();
						}),
					),
				),
			),
		);
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
								if (
									!['validating', 'ready', 'invalid'].includes(recording.status)
								)
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
				store.analysisRequests.clear();
				store.analyses.selectAnalysis(null);
				patchState(store, {
					carId,
					transfer: idleRaceRecordingTransfer(),
					removal: idleRaceRecordingRemoval(),
					analysisCreation: idleDrivingAnalysisCreation(),
				});
				store.gateway.selectCar(carId);
				monitorValidation(carId);
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
			createAnalysis(command: StartDrivingAnalysisCommand): void {
				createAnalysis({
					...command,
					requestId: store.analysisRequests.requestId(command),
				});
			},
			refreshAnalysis(): void {
				if (store.analysisCreation().analysis) store.analyses.refresh();
			},
			selectTrackMap(versionId: string | null): void {
				store.trackMaps.selectVersion(versionId);
			},
			hasSelectedFile(driveSessionId: string): boolean {
				return store.files.file(driveSessionId) !== null;
			},
			selectedFileName(driveSessionId: string): string {
				return store.files.file(driveSessionId)?.name ?? '';
			},
			retry(): void {
				store.gateway.refresh();
				store.trackMaps.refresh();
			},
		};
	}),
);
