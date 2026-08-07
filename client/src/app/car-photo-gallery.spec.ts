import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { type CarPhoto, CarPhotoGallery } from './car-photo-gallery';

type TestMember = {
	set(value: unknown): void;
	update<U>(updater: (value: U) => U): void;
};
type TestSignal<T> = TestMember & (() => T);
type GalleryTestHarness = {
	photos: TestSignal<CarPhoto[]>;
	action: TestSignal<string | null>;
	designatePrimary: (...args: unknown[]) => unknown;
	move: (...args: unknown[]) => unknown;
};

describe('CarPhotoGallery', () => {
	let fixture: ComponentFixture<CarPhotoGallery>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarPhotoGallery],
			providers: [provideHttpClient(), provideHttpClientTesting()],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(CarPhotoGallery);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		http.expectOne('/api/v1/cars/car-1/photos').flush({ photos: [] });
		await fixture.whenStable();
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('loads an owner-scoped gallery with credentials and renders the primary photo', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const photo = {
			id: 'photo-1',
			carId: 'car-1',
			objectKey: 'owner/car-1/photo-1.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
			isPrimary: true,
		};
		app.photos.set([photo]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Primary photo');
		expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toBe(
			'/api/v1/photos/photo-1',
		);
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

	it('persists primary selection and displays unauthorized errors', () => {
		const app = fixture.componentInstance as unknown as GalleryTestHarness;
		const photo = {
			id: 'photo-1',
			carId: 'car-1',
			objectKey: 'photo-1.webp',
			contentType: 'image/webp',
			createdAt: '2026-08-03T00:00:00Z',
			sortOrder: 0,
		};
		app.photos.set([photo]);
		app.designatePrimary(photo);
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
});
