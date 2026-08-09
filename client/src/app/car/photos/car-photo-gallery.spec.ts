import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarPhoto, PhotoMutationCommand } from '../car.models';
import { CarPhotoGallery } from './car-photo-gallery';
import { CarPhotoStore } from './car-photo-store';

const photo = (overrides: Partial<CarPhoto> = {}): CarPhoto => ({
	id: 'photo-1',
	carId: 'car-1',
	objectKey: 'owner/car-1/photo-1.webp',
	contentType: 'image/webp',
	createdAt: '2026-08-03T00:00:00Z',
	sortOrder: 0,
	...overrides,
});

class FakePhotoStore {
	readonly photos = signal<CarPhoto[]>([]);
	readonly loading = signal(false);
	readonly failure = signal<{ message: string; retryable: boolean } | null>(
		null,
	);
	readonly error = signal('');
	readonly action = signal<string | null>(null);
	readonly selectCar = vi.fn();
	readonly retry = vi.fn();
	readonly mutate = vi.fn<(command: PhotoMutationCommand) => void>();
}

type Harness = {
	validationError(): string;
	pendingDelete(): CarPhoto | null;
	photos(): CarPhoto[];
	state(): string;
	photoUrl(photo: CarPhoto): string;
	isPrimary(photo: CarPhoto): boolean;
	photoPosition(photo: CarPhoto, index: number): number;
	onUpload(event: Event): void;
	onReplace(event: Event, photo: CarPhoto): void;
	move(photo: CarPhoto, direction: -1 | 1): void;
	designatePrimary(photo: CarPhoto): void;
	delete(photo: CarPhoto): void;
	confirmDelete(): void;
	cancelDelete(): void;
	retry(): void;
	upload(file: File): void;
	replace(photo: CarPhoto, file: File): void;
	sendFile(file: File, action: 'upload' | 'replace', photo?: CarPhoto): void;
	persistOrder(photos: CarPhoto[]): void;
	validate(file: File): boolean;
	ordered(photos: CarPhoto[]): CarPhoto[];
};

describe('CarPhotoGallery', () => {
	let fixture: ComponentFixture<CarPhotoGallery>;
	let store: FakePhotoStore;
	let app: Harness;

	beforeEach(async () => {
		store = new FakePhotoStore();
		await TestBed.configureTestingModule({
			imports: [CarPhotoGallery],
			providers: [{ provide: CarPhotoStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(CarPhotoGallery);
		app = fixture.componentInstance as unknown as Harness;
	});

	const open = (carId = 'car-1'): void => {
		fixture.componentRef.setInput('carId', carId);
		fixture.detectChanges();
	};

	it('selects route cars and clears presentation state when the car changes', () => {
		fixture.detectChanges();
		expect(store.selectCar).not.toHaveBeenCalled();
		open();
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		app.validate(new File(['x'], 'bad.txt', { type: 'text/plain' }));
		app.delete(photo());
		expect(app.validationError()).toBeTruthy();
		expect(app.pendingDelete()).toBeTruthy();
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		expect(store.selectCar).toHaveBeenLastCalledWith('car-2');
		expect(app.validationError()).toBe('');
		expect(app.pendingDelete()).toBeNull();
	});

	it('renders loading, failures, empty, archived, mutation, and gallery states', () => {
		open();
		store.loading.set(true);
		fixture.detectChanges();
		expect(app.state()).toBe('loading');
		expect(fixture.nativeElement.textContent).toContain('Loading photos');

		store.loading.set(false);
		store.failure.set({ message: 'Offline', retryable: true });
		fixture.detectChanges();
		expect(app.state()).toBe('error');
		(
			fixture.nativeElement.querySelector(
				'.error-state button',
			) as HTMLButtonElement
		).click();
		expect(store.retry).toHaveBeenCalledOnce();
		store.failure.set({ message: 'Expired', retryable: false });
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('.error-state button'),
		).toBeNull();

		store.failure.set(null);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('No photos yet');
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('archived car has no');
		store.photos.set([photo({ primary: true })]);
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.photo-actions')).toBeNull();

		fixture.componentRef.setInput('archived', false);
		store.error.set('Mutation failed');
		store.action.set('delete:photo-2');
		store.photos.set([
			photo({ primary: true, url: '/signed.webp' }),
			photo({ id: 'photo-2', sortOrder: 1 }),
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Mutation failed');
		expect(fixture.nativeElement.textContent).toContain(
			'Saving the private gallery',
		);
		expect(fixture.nativeElement.textContent).toContain('Deleting photo…');
		expect(fixture.nativeElement.querySelectorAll('article')).toHaveLength(2);
		expect(fixture.nativeElement.querySelector('img').src).toContain(
			'/signed.webp',
		);
	});

	it('dispatches every rendered gallery control', () => {
		open();
		const first = photo({ primary: true });
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		store.photos.set([first, second]);
		fixture.detectChanges();
		const valid = new File(['x'], 'car.webp', { type: 'image/webp' });

		const upload = fixture.nativeElement.querySelector(
			'.upload-button input',
		) as HTMLInputElement;
		Object.defineProperty(upload, 'files', { value: [valid] });
		upload.dispatchEvent(new Event('change'));
		expect(store.mutate).toHaveBeenCalledWith({ kind: 'upload', file: valid });

		(
			fixture.nativeElement.querySelector(
				'[aria-label="Move photo later: photo 1"]',
			) as HTMLButtonElement
		).click();
		(
			fixture.nativeElement.querySelector(
				'[aria-label="Move photo earlier: photo 2"]',
			) as HTMLButtonElement
		).click();
		(
			fixture.nativeElement.querySelector(
				'[aria-label="Make primary: photo 2"]',
			) as HTMLButtonElement
		).click();

		const replace = fixture.nativeElement.querySelector(
			'[aria-label="Replace photo 1"]',
		) as HTMLInputElement;
		Object.defineProperty(replace, 'files', { value: [valid] });
		replace.dispatchEvent(new Event('change'));
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'replace',
			photo: first,
			file: valid,
		});

		const deleteSecond = (): void =>
			(
				fixture.nativeElement.querySelector(
					'[aria-label="Delete photo 2"]',
				) as HTMLButtonElement
			).click();
		deleteSecond();
		fixture.detectChanges();
		(
			fixture.nativeElement.querySelector(
				'[role="alertdialog"] button',
			) as HTMLButtonElement
		).click();
		expect(app.pendingDelete()).toBeNull();

		deleteSecond();
		fixture.detectChanges();
		const dialogButtons = fixture.nativeElement.querySelectorAll(
			'[role="alertdialog"] button',
		) as NodeListOf<HTMLButtonElement>;
		dialogButtons[1].click();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'delete',
			photo: second,
		});
	});

	it('validates uploads and dispatches one immutable upload command', () => {
		open();
		for (const [file, message] of [
			[new File(['x'], 'notes.txt', { type: 'text/plain' }), 'JPEG'],
			[
				new File([], 'empty.webp', { type: 'image/webp' }),
				'smaller than 10 MB',
			],
			[
				new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.webp', {
					type: 'image/webp',
				}),
				'smaller than 10 MB',
			],
			[new File(['x'], ' ', { type: 'image/png' }), 'valid filename'],
			[
				new File(['x'], 'x'.repeat(256), { type: 'image/png' }),
				'valid filename',
			],
		] as const) {
			expect(app.validate(file)).toBe(false);
			expect(app.validationError()).toContain(message);
		}
		const valid = new File(['x'], 'car.webp', { type: 'image/webp' });
		expect(app.validate(valid)).toBe(true);
		app.upload(valid);
		expect(store.mutate).toHaveBeenCalledWith({ kind: 'upload', file: valid });

		const eventTarget = { files: [valid], value: 'chosen' };
		app.onUpload({ target: eventTarget } as unknown as Event);
		expect(eventTarget.value).toBe('');
		app.onUpload({
			target: { files: [], value: 'chosen' },
		} as unknown as Event);

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.upload(valid);
		fixture.componentRef.setInput('archived', false);
		store.action.set('busy');
		app.upload(valid);
		expect(store.mutate).toHaveBeenCalledTimes(2);
	});

	it('validates replacement identity and dispatches file replacement', () => {
		open();
		const current = photo();
		const valid = new File(['x'], 'replacement.png', { type: 'image/png' });
		app.replace(current, valid);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'replace',
			photo: current,
			file: valid,
		});
		const target = { files: [valid], value: 'chosen' };
		app.onReplace({ target } as unknown as Event, current);
		expect(target.value).toBe('');
		app.onReplace(
			{ target: { files: [], value: 'chosen' } } as unknown as Event,
			current,
		);
		app.replace({ ...current, carId: 'other' }, valid);
		app.replace(current, new File(['x'], 'bad.txt', { type: 'text/plain' }));
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.replace(current, valid);
		fixture.componentRef.setInput('archived', false);
		store.action.set('busy');
		app.replace(current, valid);
		app.sendFile(valid, 'replace');
		expect(store.mutate).toHaveBeenCalledTimes(2);
	});

	it('reorders complete same-car galleries and rejects invalid moves', () => {
		open();
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		store.photos.set([first, second]);
		app.move(second, -1);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'reorder',
			photos: [second, first],
		});
		store.mutate.mockClear();
		app.move(first, -1);
		app.move(second, 1);
		app.move(photo({ id: 'missing' }), 1);
		app.move(photo({ carId: 'other' }), 1);
		store.action.set('busy');
		app.move(first, 1);
		app.persistOrder([first, photo({ id: 'other', carId: 'other' })]);
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('dispatches primary selection only for eligible gallery photos', () => {
		open();
		const candidate = photo();
		app.designatePrimary(candidate);
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'primary',
			photo: candidate,
		});
		store.mutate.mockClear();
		app.designatePrimary({ ...candidate, carId: 'other' });
		app.designatePrimary({ ...candidate, isPrimary: true });
		app.designatePrimary({ ...candidate, primary: true });
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.designatePrimary(candidate);
		fixture.componentRef.setInput('archived', false);
		store.action.set('busy');
		app.designatePrimary(candidate);
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('owns accessible delete confirmation and dispatches only after confirmation', () => {
		open();
		const current = photo();
		app.delete(current);
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('[role="alertdialog"]'),
		).toBeTruthy();
		app.cancelDelete();
		expect(app.pendingDelete()).toBeNull();
		app.delete(current);
		store.action.set('busy');
		app.cancelDelete();
		expect(app.pendingDelete()).toEqual(current);
		app.confirmDelete();
		expect(store.mutate).not.toHaveBeenCalled();
		store.action.set(null);
		app.confirmDelete();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'delete',
			photo: current,
		});
		expect(app.pendingDelete()).toBeNull();
		app.confirmDelete();

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.delete(current);
		fixture.componentRef.setInput('archived', false);
		app.delete({ ...current, carId: 'other' });
		store.action.set('busy');
		app.delete(current);
		expect(app.pendingDelete()).toBeNull();
	});

	it('normalizes photo aliases and orders ties deterministically', () => {
		open();
		const positioned = photo({ sortOrder: undefined, position: 2 });
		const fallback = photo({
			id: 'photo-2',
			sortOrder: undefined,
			position: undefined,
		});
		expect(app.photoPosition(positioned, 9)).toBe(2);
		expect(app.photoPosition(fallback, 9)).toBe(9);
		expect(app.photoUrl({ ...positioned, url: '/signed.webp' })).toBe(
			'/signed.webp',
		);
		expect(
			app.photoUrl({ ...positioned, id: 'photo/one', url: undefined }),
		).toBe('/api/v1/photos/photo%2Fone');
		expect(app.isPrimary({ ...positioned, primary: true })).toBe(true);
		expect(app.isPrimary(positioned)).toBe(false);
		expect(
			app
				.ordered([
					photo({ id: 'b', sortOrder: 0, createdAt: '2026-08-04' }),
					photo({ id: 'c', sortOrder: 0, createdAt: '2026-08-03' }),
					photo({ id: 'a', sortOrder: 0, createdAt: '2026-08-03' }),
				])
				.map((item) => item.id),
		).toEqual(['a', 'c', 'b']);
	});
});
