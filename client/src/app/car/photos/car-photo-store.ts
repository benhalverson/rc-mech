import {
	computed,
	ErrorHandler,
	inject,
	resource,
	signal,
} from '@angular/core';
import {
	patchState,
	signalStore,
	withComputed,
	withMethods,
	withProps,
	withState,
} from '@ngrx/signals';
import { rxMethod } from '@ngrx/signals/rxjs-interop';
import { catchError, exhaustMap, map, type Observable, of, tap } from 'rxjs';
import type {
	CarPhoto,
	PhotoGatewayFailure,
	PhotoMutationCommand,
	PhotoMutationOutcome,
} from '../car.models';
import { carReadFailure } from '../car-read-failure';
import { CarPhotoGateway } from './car-photo-gateway';
import { PhotoMediaAccess } from './photo-media-access';
import { PhotoWorkspaceStore } from './photo-workspace-store';

type PhotoMedia = Readonly<{
	urls: Readonly<Record<string, string | null>>;
	error: string;
}>;

type PhotoMutationResult =
	| { readonly kind: 'upload'; readonly photo: CarPhoto }
	| { readonly kind: 'replace'; readonly photo: CarPhoto }
	| { readonly kind: 'primary'; readonly photo: CarPhoto }
	| {
			readonly kind: 'delete';
			readonly photoId: string;
			readonly primaryPhotoId?: string | null;
	  }
	| { readonly kind: 'reorder'; readonly photos: CarPhoto[] };

const mutationRequest = (
	gateway: CarPhotoGateway,
	carId: string,
	command: PhotoMutationCommand,
): Observable<PhotoMutationResult> => {
	switch (command.kind) {
		case 'upload':
			return gateway
				.upload(carId, command.file)
				.pipe(map((photo) => ({ kind: 'upload', photo }) as const));
		case 'replace':
			return gateway
				.replace(command.photo, command.file)
				.pipe(map((photo) => ({ kind: 'replace', photo }) as const));
		case 'primary':
			return gateway
				.setPrimary(command.photo)
				.pipe(map((photo) => ({ kind: 'primary', photo }) as const));
		case 'delete':
			return gateway.delete(command.photo).pipe(
				map((result) => ({
					kind: 'delete' as const,
					photoId: command.photo.id,
					primaryPhotoId: result.primaryPhotoId,
				})),
			);
		case 'reorder':
			return gateway
				.reorder(carId, command.photos)
				.pipe(map((photos) => ({ kind: 'reorder', photos }) as const));
	}
};

const idleOutcome = (): PhotoMutationOutcome => ({
	status: 'idle',
	operationId: null,
});

const actionName = (command: PhotoMutationCommand): string =>
	command.kind === 'primary' ||
	command.kind === 'delete' ||
	command.kind === 'replace'
		? `${command.kind}:${command.photo.id}`
		: command.kind;

const mutationError = (
	failure: PhotoGatewayFailure,
	command: PhotoMutationCommand,
): string => {
	if (failure.kind === 'http') {
		if (failure.status === 401)
			return 'Your garage session has expired. Sign in again to continue.';
		if (failure.status === 403 || failure.status === 404)
			return 'This photo is not available in your garage.';
		if (failure.status === 409)
			return 'The car is archived. Restore it before changing photos.';
		if ([413, 415, 422].includes(failure.status))
			return 'The Worker rejected this image. Check its format, size, and metadata.';
	}
	return command.kind === 'upload'
		? 'The photo could not be uploaded.'
		: command.kind === 'replace'
			? 'The photo could not be replaced.'
			: command.kind === 'primary'
				? 'The primary photo could not be saved.'
				: command.kind === 'delete'
					? 'The photo could not be deleted.'
					: 'The photo order could not be saved.';
};

/**
 * Projects the selected Car gallery and translates gallery intents into workspace
 * commands, retaining the legacy HTTP path when local preparation is unavailable.
 * Owns route outcomes; resource() manages private-original reads as gallery inputs
 * change, streaming each result so slow downloads never block cached originals.
 * Its cancellation signal releases PhotoMediaAccess URLs and pending HTTP reads
 * on replacement or route destruction. Expected missing originals remain local to
 * each photo; access and unexpected failures surface without hiding other images.
 * Durable mutations stay explicit.
 */
export const CarPhotoStore = signalStore(
	withState<{
		carId: string;
		localPhotos: CarPhoto[] | null;
		outcome: PhotoMutationOutcome;
	}>({
		carId: '',
		localPhotos: null,
		outcome: idleOutcome(),
	}),
	withProps(() => ({
		gateway: inject(CarPhotoGateway),
		workspace: inject(PhotoWorkspaceStore),
		mediaAccess: inject(PhotoMediaAccess),
		errorHandler: inject(ErrorHandler),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		photos: computed(
			() =>
				(store.workspace.available()
					? [
							...store.workspace
								.photos()
								.filter((photo) => photo.carId === store.carId()),
						]
					: null) ??
				store.localPhotos() ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value().photos
					: []),
		),
		loading: computed(
			() =>
				!store.workspace.available() && store.gateway.collection.isLoading(),
		),
		offline: computed(() => store.workspace.offline.networkUnavailable()),
		captureFeedback: computed(() =>
			store.workspace
				.captures()
				.filter((capture) => capture.carId === store.carId())
				.map((capture) =>
					capture.status === 'pending'
						? 'Pending sync'
						: `Needs attention: ${capture.feedback}`,
				)
				.join('; '),
		),
		captureOutcome: computed(() => store.workspace.outcome()),
		failure: computed(() => {
			if (store.workspace.available()) return null;
			const failure = store.gateway.failure();
			return carReadFailure(
				failure?.kind === 'http' ? { status: failure.status } : failure,
				'The photo gallery could not be loaded.',
			);
		}),
		action: computed(() => {
			if (store.workspace.outcome().status === 'pending') return 'upload';
			const outcome = store.outcome();
			return outcome.status === 'pending' ? actionName(outcome.command) : null;
		}),
	})),
	withProps((store) => ({
		mediaResource: resource({
			params: () => ({
				photos: store.workspace.available() ? store.photos() : [],
				fence: {
					ownerKey: store.workspace.offline.ownerKey(),
					sessionKey: store.workspace.offline.sessionKey(),
				},
				offline: store.offline(),
			}),
			defaultValue: { urls: {}, error: '' } as PhotoMedia,
			stream: ({ params, abortSignal }) => {
				const media = signal({ value: { urls: {}, error: '' } as PhotoMedia });
				for (const photo of params.photos) {
					void (async () => {
						let url: string | null = null;
						let message = '';
						try {
							url = await store.mediaAccess.open(
								photo.id,
								params.fence,
								params.offline,
								abortSignal,
							);
						} catch (error: unknown) {
							if (abortSignal.aborted) return;
							const failure = error as PhotoGatewayFailure | null;
							if (
								failure?.kind === 'http' &&
								[401, 403].includes(failure.status)
							) {
								message =
									'Your garage session cannot access a photo original. Sign in again to continue.';
							} else if (
								failure?.kind !== 'unavailable' &&
								!(
									failure?.kind === 'http' &&
									(failure.status === 404 || failure.status >= 500)
								)
							) {
								message = 'A photo original could not be loaded. Try again.';
								store.errorHandler.handleError(error);
							}
						}
						if (!abortSignal.aborted)
							media.update(({ value }) => ({
								value: {
									urls: { ...value.urls, [photo.id]: url },
									error: message || value.error,
								},
							}));
					})();
				}
				return media;
			},
		}),
	})),
	withComputed((store) => ({
		media: computed(() => store.mediaResource.value().urls),
		error: computed(() => {
			const capture = store.workspace.outcome();
			if (capture.status === 'failed') return capture.message;
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? mutationError(outcome.error, outcome.command)
				: store.mediaResource.value().error;
		}),
	})),
	withMethods((store) => {
		const mutate = rxMethod<PhotoMutationCommand>((commands$) =>
			commands$.pipe(
				exhaustMap((command) => {
					const carId = store.carId();
					const operationId = ++store.nextOperationId.value;
					const previous = store.localPhotos();
					const optimistic =
						command.kind === 'reorder'
							? command.photos.map((photo, sortOrder) => ({
									...photo,
									sortOrder,
								}))
							: null;
					patchState(store, {
						outcome: { status: 'pending', operationId, command },
						...(optimistic ? { localPhotos: optimistic } : {}),
					});
					const request = mutationRequest(store.gateway, carId, command);
					return request.pipe(
						tap((result) => {
							if (store.carId() !== carId) return;
							const photos =
								store.localPhotos() ??
								(store.gateway.collection.hasValue()
									? store.gateway.collection.value().photos
									: []);
							const next =
								result.kind === 'upload'
									? [...photos, result.photo]
									: result.kind === 'replace'
										? photos.map((photo) =>
												photo.id === result.photo.id ? result.photo : photo,
											)
										: result.kind === 'primary'
											? photos.map((photo) =>
													photo.id === result.photo.id
														? result.photo
														: { ...photo, isPrimary: false, primary: false },
												)
											: result.kind === 'delete'
												? photos
														.filter((photo) => photo.id !== result.photoId)
														.map((photo) => ({
															...photo,
															isPrimary: photo.id === result.primaryPhotoId,
															primary: photo.id === result.primaryPhotoId,
														}))
												: result.photos.length
													? result.photos
													: (optimistic as CarPhoto[]);
							patchState(store, {
								localPhotos: [...next],
								outcome: { status: 'succeeded', operationId, command },
							});
							store.gateway.refresh();
							if (store.workspace.available())
								store.workspace.refresh(
									result.kind === 'replace'
										? result.photo.id
										: result.kind === 'delete'
											? result.photoId
											: undefined,
								);
						}),
						catchError((error: PhotoGatewayFailure) => {
							if (store.carId() === carId)
								patchState(store, {
									localPhotos:
										command.kind === 'reorder' ? previous : store.localPhotos(),
									outcome: { status: 'failed', operationId, command, error },
								});
							return of(null);
						}),
					);
				}),
			),
		);

		return {
			selectCar(carId: string): void {
				if (store.carId() === carId) return;
				patchState(store, { carId, localPhotos: null, outcome: idleOutcome() });
				store.gateway.selectCar(carId);
			},
			retry(): void {
				patchState(store, { outcome: idleOutcome() });
				store.gateway.refresh();
				store.mediaResource.reload();
				if (store.workspace.available()) store.workspace.refresh();
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: PhotoMutationCommand): void {
				if (!store.carId() || store.action()) return;
				if (command.kind === 'upload' && store.workspace.available()) {
					store.workspace.mutate({
						requestId: String(++store.nextOperationId.value),
						change: { carId: store.carId(), file: command.file },
					});
					return;
				}
				if (store.offline()) return;
				mutate(command);
			},
		};
	}),
);
