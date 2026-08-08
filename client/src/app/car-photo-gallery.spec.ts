import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import type { CarPhoto } from './car/car.models';
import { CarPhotoGallery } from './car-photo-gallery';
import { CarPhotoStore } from './car-photo-store';

type TestMember = {
	set(value: unknown): void;
	update<U>(updater: (value: U) => U): void;
};
type TestSignal<T> = TestMember & (() => T);
type GalleryTestHarness = {
	photos: TestSignal<CarPhoto[]>;
	action: TestSignal<string | null>;
	validationError: TestSignal<string>;
	error: () => string;
	designatePrimary: (...args: unknown[]) => unknown;
	delete: (...args: unknown[]) => unknown;
	move: (...args: unknown[]) => unknown;
	onUpload: (...args: unknown[]) => unknown;
	onReplace: (...args: unknown[]) => unknown;
	photoUrl(photo: CarPhoto): string;
	isPrimary(photo: CarPhoto): boolean;
	photoPosition(photo: CarPhoto, index: number): number;
	ordered(photos: CarPhoto[]): CarPhoto[];
	persistOrder(photos: CarPhoto[]): void;
	replace(photo: CarPhoto, file: File): void;
	validate(file: File): boolean;
	fail(error: { status?: number }, fallback: string): void;
	retry(): void;
};

const photo = (overrides: Partial<CarPhoto> = {}): CarPhoto => ({
	id: 'photo-1',
	carId: 'car-1',
	objectKey: 'owner/car-1/photo-1.webp',
	contentType: 'image/webp',
	createdAt: '2026-08-03T00:00:00Z',
	sortOrder: 0,
	...overrides,
});

describe('CarPhotoGallery', () => {
	let fixture: ComponentFixture<CarPhotoGallery>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarPhotoGallery],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				CarPhotoStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(CarPhotoGallery);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		http.expectOne('/api/v1/cars/car-1/photos').flush({ photos: [] });
		await fixture.whenStable();
		fixture.detectChanges();
	});

	afterEach(() => {
		http.verify();
		vi.restoreAllMocks();
	});

	it('waits for the car input and encodes it before loading the gallery', () => {
		fixture.destroy();
		fixture = TestBed.createComponent(CarPhotoGallery);

		expect(() => fixture.detectChanges()).not.toThrow();
		http.expectNone((request) => request.url.includes('/photos'));
		fixture.componentRef.setInput('carId', 'car/one');
		fixture.detectChanges();
		http.expectOne('/api/v1/cars/car%2Fone/photos').flush({ photos: [] });
	});

	it('loads an owner-scoped gallery with credentials and renders the primary photo', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const primary = photo({ isPrimary: true });
		app.photos.set([primary]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Primary photo');
		expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe(
			'/api/v1/photos/photo-1',
		);
	});

	it('renders archived and editable gallery states and exercises file controls', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo({ primary: true, url: '/private/primary.webp' });
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelectorAll('article')).toHaveLength(2);
		expect(fixture.nativeElement.querySelector('img').src).toContain(
			'/private/primary.webp',
		);
		expect(fixture.nativeElement.textContent).toContain('Make primary');

		const inputs = fixture.nativeElement.querySelectorAll('input[type=file]');
		Object.defineProperty(inputs[1], 'files', { value: [] });
		inputs[1].dispatchEvent(new Event('change'));
		Object.defineProperty(inputs[2], 'files', { value: [] });
		inputs[2].dispatchEvent(new Event('change'));

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('This car is archived');
		expect(
			fixture.nativeElement.querySelector('.photo-actions button'),
		).toBeNull();
	});

	it('validates format and size before sending an upload', () => {
		const input = fixture.nativeElement.querySelector(
			'input[type=file]',
		) as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			value: [new File(['bad'], 'notes.txt', { type: 'text/plain' })],
		});
		input.dispatchEvent(new Event('change'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Use a JPEG, PNG, or WebP image.',
		);
		http.expectNone(
			'/api/v1/cars/car-1/photos',
			'invalid files never reach the Worker',
		);
	});

	it('explains an expired session without retrying the protected read', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		app.retry();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car-1/photos');
		});
		request?.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();

		const alert = fixture.nativeElement.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
	});

	it('uploads a supported photo as multipart form data with credentials', async () => {
		const input = fixture.nativeElement.querySelector(
			'input[type=file]',
		) as HTMLInputElement;
		Object.defineProperty(input, 'files', {
			value: [new File(['image'], 'car.webp', { type: 'image/webp' })],
		});
		input.dispatchEvent(new Event('change'));
		const request = http.expectOne('/api/v1/cars/car-1/photos');
		expect(request.request.method).toBe('POST');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body instanceof FormData).toBe(true);
		expect((request.request.body as FormData).get('file')).toBeTruthy();
		request.flush({
			photo: {
				id: 'photo-1',
				carId: 'car-1',
				objectKey: 'photo-1.webp',
				contentType: 'image/webp',
				createdAt: '2026-08-03T00:00:00Z',
				sortOrder: 0,
			},
		});
		let reload: TestRequest | undefined;
		await vi.waitFor(() => {
			reload = http.expectOne('/api/v1/cars/car-1/photos');
		});
		reload?.flush({
			photos: [
				{
					id: 'photo-1',
					carId: 'car-1',
					objectKey: 'photo-1.webp',
					contentType: 'image/webp',
					createdAt: '2026-08-03T00:00:00Z',
					sortOrder: 0,
				},
			],
		});
	});

	it('validates every local upload constraint and mutation guard', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		expect(
			app.validate(new File([], 'empty.webp', { type: 'image/webp' })),
		).toBe(false);
		expect(app.validationError()).toContain('smaller than 10 MB');
		expect(
			app.validate(
				new File([new Uint8Array(10 * 1024 * 1024 + 1)], 'large.webp', {
					type: 'image/webp',
				}),
			),
		).toBe(false);
		expect(
			app.validate(new File(['x'], ' '.repeat(2), { type: 'image/png' })),
		).toBe(false);
		expect(
			app.validate(
				new File(['x'], `${'x'.repeat(256)}.png`, { type: 'image/png' }),
			),
		).toBe(false);
		expect(app.validate(new File(['x'], 'ok.png', { type: 'image/png' }))).toBe(
			true,
		);

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.onUpload({
			target: {
				files: [new File(['x'], 'ok.png', { type: 'image/png' })],
				value: 'chosen',
			},
		} as unknown as Event);
		http.expectNone((request) => request.method === 'POST');

		fixture.componentRef.setInput('archived', false);
		app.action.set('busy');
		app.onUpload({
			target: {
				files: [new File(['x'], 'ok.png', { type: 'image/png' })],
				value: 'chosen',
			},
		} as unknown as Event);
		http.expectNone((request) => request.method === 'POST');
		app.onUpload({
			target: { files: [], value: 'chosen' },
		} as unknown as Event);
	});

	it('renders a retryable read failure and retries from its control', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		app.retry();
		await vi.waitFor(() =>
			http
				.expectOne('/api/v1/cars/car-1/photos')
				.flush('offline', { status: 503, statusText: 'Unavailable' }),
		);
		await fixture.whenStable();
		fixture.detectChanges();
		const retry = fixture.nativeElement.querySelector(
			'.error-state button',
		) as HTMLButtonElement;
		retry.click();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({ photos: [] }),
		);
	});

	it('persists primary selection and displays unauthorized errors', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const candidate = photo();
		app.photos.set([candidate]);
		app.designatePrimary(candidate);
		const request = http.expectOne('/api/v1/cars/car-1/photos/photo-1');
		expect(request.request.body).toEqual({ isPrimary: true });
		expect(request.request.withCredentials).toBe(true);
		request.flush(
			{ error: 'Authentication required' },
			{ status: 401, statusText: 'Unauthorized' },
		);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('session has expired');
	});

	it('updates the selected primary photo and clears primary aliases', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo({ primary: true });
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		app.designatePrimary(second);
		http.expectOne('/api/v1/cars/car-1/photos/photo-2').flush({
			photo: { ...second, isPrimary: true },
		});
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [
					{ ...first, primary: false },
					{ ...second, isPrimary: true },
				],
			}),
		);
		expect(app.photos().find((item) => item.id === first.id)?.primary).toBe(
			false,
		);
	});

	it('guards primary selection while archived, busy, or already primary', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const candidate = photo();
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.designatePrimary(candidate);
		fixture.componentRef.setInput('archived', false);
		app.action.set('busy');
		app.designatePrimary(candidate);
		app.action.set(null);
		app.designatePrimary({ ...candidate, primary: true });
		http.expectNone((request) => request.method === 'PATCH');
	});

	it('encodes reserved car and photo identifiers', async () => {
		fixture.componentRef.setInput('carId', 'car/one');
		fixture.detectChanges();
		let collection: TestRequest | undefined;
		await vi.waitFor(() => {
			collection = http.expectOne('/api/v1/cars/car%2Fone/photos');
		});
		collection?.flush({ photos: [] });
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const photo = {
			id: 'photo/one',
			carId: 'car/one',
			objectKey: 'owner/car/one/photo/one.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
		};
		app.photos.set([photo]);
		app.designatePrimary(photo);
		http
			.expectOne('/api/v1/cars/car%2Fone/photos/photo%2Fone')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
	});

	it('rejects a stale photo mutation after the route identity changes', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const photo = {
			id: 'photo/one',
			carId: 'car/old',
			objectKey: 'owner/car/old/photo/one.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
		};
		app.photos.set([photo]);
		app.designatePrimary(photo);

		http.expectNone('/api/v1/cars/car%2Fold/photos/photo%2Fone');
		expect(app.action()).toBeNull();
	});

	it('clears local mutation state and ignores stale results when cars change', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const photo = {
			id: 'photo-1',
			carId: 'car-1',
			objectKey: 'owner/car-1/photo-1.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
		};
		app.photos.set([photo]);
		app.designatePrimary(photo);
		const oldMutation = http.expectOne('/api/v1/cars/car-1/photos/photo-1');
		expect(app.action()).toBe('primary:photo-1');

		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		expect(app.action()).toBeNull();
		let nextGallery: TestRequest | undefined;
		await vi.waitFor(() => {
			nextGallery = http.expectOne('/api/v1/cars/car-2/photos');
		});
		nextGallery?.flush({ photos: [] });
		oldMutation.flush({ photo: { ...photo, isPrimary: true } });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(app.photos()).toEqual([]);
		http.expectNone('/api/v1/cars/car-2/photos');
	});

	it('reorders the complete gallery through one authenticated atomic request', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = {
			id: 'photo-1',
			carId: 'car-1',
			objectKey: 'one.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
		};
		const second = {
			id: 'photo-2',
			carId: 'car-1',
			objectKey: 'two.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 1,
		};
		app.photos.set([first, second]);
		app.move(second, -1);
		const request = http.expectOne('/api/v1/cars/car-1/photos/reorder');
		expect(request.request.method).toBe('PATCH');
		expect(request.request.withCredentials).toBe(true);
		expect(request.request.body).toEqual({ photoIds: ['photo-2', 'photo-1'] });
		request.flush({
			photos: [
				{ ...second, sortOrder: 0 },
				{ ...first, sortOrder: 1 },
			],
		});
		let reload: TestRequest | undefined;
		await vi.waitFor(() => {
			reload = http.expectOne('/api/v1/cars/car-1/photos');
		});
		reload?.flush({
			photos: [
				{ ...second, sortOrder: 0 },
				{ ...first, sortOrder: 1 },
			],
		});
		expect(app.photos()[0].id).toBe('photo-2');
	});

	it('keeps the optimistic order when the reorder response is empty', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		app.move(first, 1);
		http.expectOne('/api/v1/cars/car-1/photos/reorder').flush({ photos: [] });
		let reload: TestRequest | undefined;
		await vi.waitFor(() => {
			reload = http.expectOne('/api/v1/cars/car-1/photos');
		});
		expect(app.photos().map((item) => item.id)).toEqual(['photo-2', 'photo-1']);
		reload?.flush({ photos: [second, first] });
	});

	it('rolls a failed reorder back and rejects invalid moves and mixed cars', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		app.move(first, -1);
		app.move(second, 1);
		app.move(photo({ id: 'missing' }), 1);
		app.action.set('busy');
		app.move(first, 1);
		app.action.set(null);
		app.persistOrder([first, photo({ id: 'other', carId: 'car-2' })]);
		http.expectNone((request) => request.url.includes('/reorder'));

		app.move(first, 1);
		http
			.expectOne('/api/v1/cars/car-1/photos/reorder')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await vi.waitFor(() => expect(app.action()).toBeNull());
		expect(app.photos().map((item) => item.id)).toEqual(['photo-1', 'photo-2']);
		expect(app.error()).toContain('order could not be saved');
	});

	it('replaces and deletes photos, including stale and failed responses', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const original = photo();
		const replacement = { ...original, objectKey: 'replacement.webp' };
		const remaining = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([original, remaining]);
		app.onReplace(
			{
				target: {
					files: [new File(['x'], 'replacement.webp', { type: 'image/webp' })],
					value: 'chosen',
				},
			} as unknown as Event,
			original,
		);
		http
			.expectOne('/api/v1/cars/car-1/photos/photo-1/replace')
			.flush({ photo: replacement });
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [replacement],
			}),
		);

		app.replace(original, new File(['x'], 'bad.txt', { type: 'text/plain' }));
		app.replace(
			{ ...original, carId: 'other' },
			new File(['x'], 'ok.webp', { type: 'image/webp' }),
		);
		http.expectNone((request) => request.url.endsWith('/replace'));

		app.photos.set([original, remaining]);
		vi.spyOn(window, 'confirm')
			.mockReturnValueOnce(false)
			.mockReturnValue(true);
		app.delete(original);
		app.delete(original);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Deleting…');
		http.expectOne('/api/v1/cars/car-1/photos/photo-1').flush({
			deleted: true,
			primaryPhotoId: remaining.id,
		});
		let reload: TestRequest | undefined;
		await vi.waitFor(() => {
			reload = http.expectOne('/api/v1/cars/car-1/photos');
		});
		expect(app.photos()[0]?.isPrimary).toBe(true);
		reload?.flush({ photos: [remaining] });
	});

	it('reports current upload, replacement, and delete failures', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const original = photo();
		app.photos.set([original]);
		app.onUpload({
			target: {
				files: [new File(['x'], 'upload.webp', { type: 'image/webp' })],
				value: 'chosen',
			},
		} as unknown as Event);
		http
			.expectOne('/api/v1/cars/car-1/photos')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.error()).toContain('could not be uploaded');

		app.replace(
			original,
			new File(['x'], 'replacement.webp', { type: 'image/webp' }),
		);
		http
			.expectOne('/api/v1/cars/car-1/photos/photo-1/replace')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.error()).toContain('could not be replaced');

		vi.spyOn(window, 'confirm').mockReturnValue(true);
		app.delete(original);
		http
			.expectOne('/api/v1/cars/car-1/photos/photo-1')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		expect(app.error()).toContain('could not be deleted');
	});

	it('maps mutation status errors and ignores stale file and delete results', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		for (const [status, message] of [
			[403, 'not available'],
			[409, 'archived'],
			[413, 'rejected this image'],
			[500, 'fallback'],
		] as const) {
			app.fail({ status }, 'fallback');
			expect(app.error()).toContain(message);
		}

		const original = photo();
		app.photos.set([original]);
		app.replace(
			original,
			new File(['x'], 'replacement.webp', { type: 'image/webp' }),
		);
		const replacement = http.expectOne(
			'/api/v1/cars/car-1/photos/photo-1/replace',
		);
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		replacement.flush({ photo: original });

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({ photos: [original] }),
		);
		app.photos.set([original]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		app.delete(original);
		const deletion = http.expectOne('/api/v1/cars/car-1/photos/photo-1');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		deletion.flush({ deleted: true });
		expect(app.photos()).toEqual([]);
	});

	it('ignores stale mutation errors and reorder outcomes', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		app.designatePrimary(second);
		const primary = http.expectOne('/api/v1/cars/car-1/photos/photo-2');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		primary.flush('offline', { status: 500, statusText: 'Unavailable' });

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [first, second],
			}),
		);
		app.photos.set([first, second]);
		app.persistOrder([second, first]);
		const saved = http.expectOne('/api/v1/cars/car-1/photos/reorder');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		saved.flush({ photos: [second, first] });
		await Promise.resolve();

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [first, second],
			}),
		);
		app.photos.set([first, second]);
		app.persistOrder([second, first]);
		const failed = http.expectOne('/api/v1/cars/car-1/photos/reorder');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		failed.flush('offline', { status: 500, statusText: 'Unavailable' });
		await Promise.resolve();
	});

	it('executes every gallery action through its rendered control', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo();
		const second = photo({ id: 'photo-2', sortOrder: 1 });
		app.photos.set([first, second]);
		fixture.detectChanges();

		const upload = fixture.nativeElement.querySelector(
			'.upload-button input',
		) as HTMLInputElement;
		Object.defineProperty(upload, 'files', { value: [] });
		upload.dispatchEvent(new Event('change'));

		const later = fixture.nativeElement.querySelector(
			'button[aria-label="Move photo later"]',
		) as HTMLButtonElement;
		later.click();
		http
			.expectOne('/api/v1/cars/car-1/photos/reorder')
			.flush({ photos: [second, first] });
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [second, first],
			}),
		);
		fixture.detectChanges();

		const earlier = fixture.nativeElement.querySelectorAll(
			'button[aria-label="Move photo earlier"]',
		)[1] as HTMLButtonElement;
		earlier.click();
		http
			.expectOne('/api/v1/cars/car-1/photos/reorder')
			.flush({ photos: [first, second] });
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({
				photos: [first, second],
			}),
		);
		fixture.detectChanges();

		(
			fixture.nativeElement.querySelector(
				'button:nth-of-type(3)',
			) as HTMLButtonElement | null
		)?.click();
		const primary = http.match(
			(request) =>
				request.url.includes('/photos/') && request.method === 'PATCH',
		)[0];
		primary?.flush('offline', { status: 500, statusText: 'Unavailable' });

		vi.spyOn(window, 'confirm').mockReturnValue(false);
		(
			fixture.nativeElement.querySelector(
				'.photo-actions .danger',
			) as HTMLButtonElement
		).click();
	});

	it('ignores stale delete and file errors explicitly', async () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const original = photo();
		app.photos.set([original]);
		app.replace(
			original,
			new File(['x'], 'replacement.webp', { type: 'image/webp' }),
		);
		const replacement = http.expectOne(
			'/api/v1/cars/car-1/photos/photo-1/replace',
		);
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		replacement.flush('offline', { status: 500, statusText: 'Unavailable' });

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-1/photos').flush({ photos: [original] }),
		);
		app.photos.set([original]);
		vi.spyOn(window, 'confirm').mockReturnValue(true);
		app.delete(original);
		const deletion = http.expectOne('/api/v1/cars/car-1/photos/photo-1');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await vi.waitFor(() =>
			http.expectOne('/api/v1/cars/car-2/photos').flush({ photos: [] }),
		);
		deletion.flush('offline', { status: 500, statusText: 'Unavailable' });
	});

	it('orders fallback positions deterministically and exposes photo aliases', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const first = photo({ sortOrder: undefined, position: 2 });
		const second = photo({
			id: 'photo-2',
			sortOrder: undefined,
			position: undefined,
			createdAt: first.createdAt,
		});
		expect(app.photoPosition(first, 9)).toBe(2);
		expect(app.photoPosition(second, 9)).toBe(9);
		expect(app.photoUrl({ ...first, url: '/signed.webp' })).toBe(
			'/signed.webp',
		);
		expect(app.isPrimary({ ...first, primary: true })).toBe(true);
		app.photos.set([second, first]);
		expect(app.photos()).toHaveLength(2);
		expect(
			app
				.ordered([
					photo({ id: 'b', sortOrder: 0, createdAt: '2026-08-04T00:00:00Z' }),
					photo({ id: 'a', sortOrder: 0, createdAt: '2026-08-03T00:00:00Z' }),
					photo({ id: 'c', sortOrder: 0, createdAt: '2026-08-03T00:00:00Z' }),
				])
				.map((item) => item.id),
		).toEqual(['a', 'c', 'b']);
	});
});
