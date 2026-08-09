import {
	Component,
	computed,
	effect,
	inject,
	input,
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
import type { CarPhoto } from '../car.models';
import { CarPhotoStore } from './car-photo-store';

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
	private readonly store = inject(CarPhotoStore);
	readonly carId = input('');
	readonly archived = input(false);

	protected readonly photos = computed(() => this.ordered(this.store.photos()));
	protected readonly state = computed(() =>
		this.store.loading() ? 'loading' : this.store.failure() ? 'error' : 'ready',
	);
	protected readonly readFailure = this.store.failure;
	protected readonly error = this.store.error;
	protected readonly action = this.store.action;
	protected readonly validationError = signal('');
	protected readonly pendingDelete = signal<CarPhoto | null>(null);

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (previousCarId !== undefined && carId !== previousCarId) {
				this.validationError.set('');
				this.pendingDelete.set(null);
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
		this.store.mutate({ kind: 'primary', photo });
	}

	protected delete(photo: CarPhoto): void {
		if (photo.carId !== this.carId() || this.archived() || this.action())
			return;
		this.pendingDelete.set(photo);
	}

	protected confirmDelete(): void {
		const photo = this.pendingDelete();
		if (!photo || this.action()) return;
		this.pendingDelete.set(null);
		this.store.mutate({ kind: 'delete', photo });
	}

	protected cancelDelete(): void {
		if (!this.action()) this.pendingDelete.set(null);
	}

	protected retry(): void {
		this.store.retry();
	}

	private upload(file: File): void {
		if (!this.validate(file) || this.archived() || this.action()) return;
		this.sendFile(file, 'upload');
	}

	private replace(photo: CarPhoto, file: File): void {
		if (
			photo.carId !== this.carId() ||
			!this.validate(file) ||
			this.archived() ||
			this.action()
		)
			return;
		this.sendFile(file, 'replace', photo);
	}

	private sendFile(
		file: File,
		action: 'upload' | 'replace',
		photo?: CarPhoto,
	): void {
		if (action === 'upload') this.store.mutate({ kind: 'upload', file });
		else if (photo) this.store.mutate({ kind: 'replace', photo, file });
	}

	private persistOrder(photos: CarPhoto[]): void {
		const carId = this.carId();
		if (photos.some((photo) => photo.carId !== carId)) return;
		this.store.mutate({ kind: 'reorder', photos });
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
}
