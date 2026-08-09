import { HttpClient } from '@angular/common/http';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	linkedSignal,
	signal,
} from '@angular/core';
import {
	LucideArchive,
	LucideImage,
	LucideMoveDown,
	LucideMoveUp,
	LucideRefreshCw,
	LucideRotateCw,
	LucideStar,
	LucideTrash2,
	LucideTriangleAlert,
	LucideUpload,
} from '@lucide/angular';
import { firstValueFrom } from 'rxjs';
import type { CarPhoto } from './car/car.models';
import { CarPhotoStore } from './car-photo-store';

type PhotosResponse = { photos: CarPhoto[] };
type PhotoResponse = { photo: CarPhoto };

const MAX_PHOTO_BYTES = 10 * 1024 * 1024;
const SUPPORTED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

@Component({
	selector: 'app-car-photo-gallery',
	host: { class: 'block' },
	imports: [
		LucideArchive,
		LucideImage,
		LucideMoveDown,
		LucideMoveUp,
		LucideRefreshCw,
		LucideRotateCw,
		LucideStar,
		LucideTrash2,
		LucideTriangleAlert,
		LucideUpload,
	],
	templateUrl: './car-photo-gallery.html',
})
export class CarPhotoGallery {
	private readonly http = inject(HttpClient);
	private readonly store = inject(CarPhotoStore);
	readonly carId = input('');
	readonly archived = input(false);

	protected readonly photos = linkedSignal(() =>
		this.ordered(this.store.photos()),
	);
	protected readonly state = computed(() =>
		this.store.loading() ? 'loading' : this.store.failure() ? 'error' : 'ready',
	);
	protected readonly readFailure = this.store.failure;
	private readonly mutationError = signal('');
	protected readonly error = computed(() => this.mutationError());
	protected readonly action = signal<string | null>(null);
	protected readonly validationError = signal('');

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (previousCarId !== undefined && carId !== previousCarId) {
				this.action.set(null);
				this.mutationError.set('');
				this.validationError.set('');
			}
			previousCarId = carId;
			if (carId) this.store.selectCar(carId);
		});
	}

	protected photoUrl(photo: CarPhoto): string {
		return photo.url || `/api/v1/photos/${encodeURIComponent(photo.id)}`;
	}

	protected isPrimary(photo: CarPhoto): boolean {
		return photo.isPrimary === true || photo.primary === true;
	}

	protected photoPosition(photo: CarPhoto, index: number): number {
		return photo.sortOrder ?? photo.position ?? index;
	}

	protected onUpload(event: Event): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		this.upload(file);
	}

	protected onReplace(event: Event, photo: CarPhoto): void {
		const input = event.target as HTMLInputElement;
		const file = input.files?.[0];
		input.value = '';
		if (!file) return;
		this.replace(photo, file);
	}

	protected move(photo: CarPhoto, direction: -1 | 1): void {
		const index = this.photos().findIndex((item) => item.id === photo.id);
		const nextIndex = index + direction;
		if (
			photo.carId !== this.carId() ||
			index < 0 ||
			nextIndex < 0 ||
			nextIndex >= this.photos().length ||
			this.action()
		)
			return;
		const reordered = [...this.photos()];
		[reordered[index], reordered[nextIndex]] = [
			reordered[nextIndex],
			reordered[index],
		];
		this.persistOrder(reordered);
	}

	protected designatePrimary(photo: CarPhoto): void {
		if (
			photo.carId !== this.carId() ||
			this.archived() ||
			this.action() ||
			this.isPrimary(photo)
		)
			return;
		const carId = photo.carId;
		this.action.set(`primary:${photo.id}`);
		this.mutationError.set('');
		this.http
			.patch<PhotoResponse>(
				this.photoEndpoint(photo),
				{ isPrimary: true },
				{ withCredentials: true },
			)
			.subscribe({
				next: ({ photo: updated }) => {
					if (this.carId() !== carId) return;
					this.photos.update((photos) =>
						photos.map((item) =>
							item.id === updated.id
								? updated
								: { ...item, isPrimary: false, primary: false },
						),
					);
					this.store.refresh();
					this.action.set(null);
				},
				error: (error: { status?: number }) => {
					if (this.carId() !== carId) return;
					this.fail(error, 'The primary photo could not be saved.');
				},
			});
	}

	protected delete(photo: CarPhoto): void {
		if (
			photo.carId !== this.carId() ||
			this.archived() ||
			this.action() ||
			!window.confirm('Delete this private car photo?')
		)
			return;
		const carId = photo.carId;
		this.action.set(`delete:${photo.id}`);
		this.mutationError.set('');
		this.http
			.delete<{ deleted: boolean; primaryPhotoId?: string | null }>(
				this.photoEndpoint(photo),
				{ withCredentials: true },
			)
			.subscribe({
				next: ({ primaryPhotoId }) => {
					if (this.carId() !== carId) return;
					this.photos.update((photos) =>
						photos
							.filter((item) => item.id !== photo.id)
							.map((item) => ({
								...item,
								isPrimary: item.id === primaryPhotoId,
								primary: item.id === primaryPhotoId,
							})),
					);
					this.store.refresh();
					this.action.set(null);
				},
				error: (error: { status?: number }) => {
					if (this.carId() !== carId) return;
					this.fail(error, 'The photo could not be deleted.');
				},
			});
	}

	protected retry(): void {
		this.mutationError.set('');
		this.store.retry();
	}

	private upload(file: File): void {
		if (!this.validate(file) || this.archived() || this.action()) return;
		const carId = this.carId();
		this.sendFile(
			`/api/v1/cars/${encodeURIComponent(carId)}/photos`,
			file,
			'upload',
			carId,
		);
	}

	private replace(photo: CarPhoto, file: File): void {
		if (
			photo.carId !== this.carId() ||
			!this.validate(file) ||
			this.archived() ||
			this.action()
		)
			return;
		this.sendFile(
			`${this.photoEndpoint(photo)}/replace`,
			file,
			`replace:${photo.id}`,
			photo.carId,
		);
	}

	private sendFile(
		url: string,
		file: File,
		action: string,
		carId: string,
	): void {
		const body = new FormData();
		body.append('file', file, file.name);
		this.action.set(action);
		this.mutationError.set('');
		this.http
			.post<PhotoResponse>(url, body, { withCredentials: true })
			.subscribe({
				next: ({ photo }) => {
					if (this.carId() !== carId) return;
					this.photos.set(
						this.ordered(
							action === 'upload'
								? [...this.photos(), photo]
								: this.photos().map((item) =>
										item.id === photo.id ? photo : item,
									),
						),
					);
					this.store.refresh();
					this.action.set(null);
				},
				error: (error: { status?: number }) => {
					if (this.carId() !== carId) return;
					this.fail(
						error,
						action === 'upload'
							? 'The photo could not be uploaded.'
							: 'The photo could not be replaced.',
					);
				},
			});
	}

	private persistOrder(photos: CarPhoto[]): void {
		const carId = this.carId();
		if (photos.some((photo) => photo.carId !== carId)) return;
		this.action.set('reorder');
		this.mutationError.set('');
		// Keep the new order visible immediately, then roll back if any owner-scoped update fails.
		const previous = this.photos();
		const optimistic = photos.map((photo, position) => ({
			...photo,
			sortOrder: position,
		}));
		this.photos.set(optimistic);
		firstValueFrom(
			this.http.patch<PhotosResponse>(
				`/api/v1/cars/${encodeURIComponent(carId)}/photos/reorder`,
				{
					photoIds: photos.map((photo) => photo.id),
				},
				{ withCredentials: true },
			),
		)
			.then(({ photos: saved }) => {
				if (this.carId() !== carId) return;
				this.photos.set(saved?.length ? this.ordered(saved) : optimistic);
				this.store.refresh();
				this.action.set(null);
			})
			.catch((error: { status?: number }) => {
				if (this.carId() !== carId) return;
				this.photos.set(previous);
				this.fail(error, 'The photo order could not be saved.');
			});
	}

	private validate(file: File): boolean {
		this.validationError.set('');
		if (!SUPPORTED_TYPES.has(file.type)) {
			this.validationError.set('Use a JPEG, PNG, or WebP image.');
			return false;
		}
		if (file.size === 0 || file.size > MAX_PHOTO_BYTES) {
			this.validationError.set('Photos must be smaller than 10 MB.');
			return false;
		}
		if (!file.name.trim() || file.name.length > 255) {
			this.validationError.set('Choose a photo with a valid filename.');
			return false;
		}
		return true;
	}

	private ordered(photos: CarPhoto[]): CarPhoto[] {
		return [...photos].sort(
			(left, right) =>
				this.photoPosition(left, 0) - this.photoPosition(right, 0) ||
				left.createdAt.localeCompare(right.createdAt) ||
				left.id.localeCompare(right.id),
		);
	}

	private photoEndpoint(photo: CarPhoto): string {
		return `/api/v1/cars/${encodeURIComponent(photo.carId)}/photos/${encodeURIComponent(photo.id)}`;
	}

	private fail(error: { status?: number }, fallback: string): void {
		this.action.set(null);
		this.mutationError.set(
			error.status === 401
				? 'Your garage session has expired. Sign in again to continue.'
				: error.status === 403 || error.status === 404
					? 'This photo is not available in your garage.'
					: error.status === 409
						? 'The car is archived. Restore it before changing photos.'
						: error.status === 413 ||
								error.status === 415 ||
								error.status === 422
							? 'The Worker rejected this image. Check its format, size, and metadata.'
							: fallback,
		);
	}
}
