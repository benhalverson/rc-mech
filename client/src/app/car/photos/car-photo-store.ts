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
import { catchError, exhaustMap, map, type Observable, of, tap } from 'rxjs';
import type {
	CarPhoto,
	PhotoGatewayFailure,
	PhotoMutationCommand,
	PhotoMutationOutcome,
} from '../car.models';
import { carReadFailure } from '../car-read-failure';
import { CarPhotoGateway } from './car-photo-gateway';

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

export const CarPhotoStore = signalStore(
	withState<{
		carId: string;
		localPhotos: CarPhoto[] | null;
		outcome: PhotoMutationOutcome;
	}>({ carId: '', localPhotos: null, outcome: idleOutcome() }),
	withProps(() => ({
		gateway: inject(CarPhotoGateway),
		nextOperationId: { value: 0 },
	})),
	withComputed((store) => ({
		photos: computed(
			() =>
				store.localPhotos() ??
				(store.gateway.collection.hasValue()
					? store.gateway.collection.value().photos
					: []),
		),
		loading: computed(() => store.gateway.collection.isLoading()),
		failure: computed(() => {
			const failure = store.gateway.failure();
			return carReadFailure(
				failure?.kind === 'http' ? { status: failure.status } : failure,
				'The photo gallery could not be loaded.',
			);
		}),
		action: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'pending' ? actionName(outcome.command) : null;
		}),
		error: computed(() => {
			const outcome = store.outcome();
			return outcome.status === 'failed'
				? mutationError(outcome.error, outcome.command)
				: '';
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
			},
			clearOutcome(): void {
				patchState(store, { outcome: idleOutcome() });
			},
			mutate(command: PhotoMutationCommand): void {
				if (!store.carId() || store.outcome().status === 'pending') return;
				mutate(command);
			},
		};
	}),
);
