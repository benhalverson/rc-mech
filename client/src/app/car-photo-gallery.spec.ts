import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { CarPhotoGallery } from './car-photo-gallery';

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
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('loads an owner-scoped gallery with credentials and renders the primary photo', () => {
    const app = fixture.componentInstance as any;
    const photo = { id: 'photo-1', carId: 'car-1', objectKey: 'owner/car-1/photo-1.webp', contentType: 'image/webp', createdAt: '2026-08-03T00:00:00Z', sortOrder: 0, isPrimary: true };
    app.photos.set([photo]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Primary photo');
    expect(fixture.nativeElement.querySelector('img').getAttribute('src')).toContain(encodeURIComponent(photo.objectKey));
  });

  it('validates format and size before sending an upload', () => {
    const input = fixture.nativeElement.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['bad'], 'notes.txt', { type: 'text/plain' })] });
    input.dispatchEvent(new Event('change'));
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Use a JPEG, PNG, or WebP image.');
    http.expectNone('/api/v1/cars/car-1/photos', 'invalid files never reach the Worker');
  });

  it('uploads a supported photo as multipart form data with credentials', () => {
    const input = fixture.nativeElement.querySelector('input[type=file]') as HTMLInputElement;
    Object.defineProperty(input, 'files', { value: [new File(['image'], 'car.webp', { type: 'image/webp' })] });
    input.dispatchEvent(new Event('change'));
    const request = http.expectOne('/api/v1/cars/car-1/photos');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body instanceof FormData).toBe(true);
    expect((request.request.body as FormData).get('file')).toBeTruthy();
    request.flush({ photo: { id: 'photo-1', carId: 'car-1', objectKey: 'photo-1.webp', contentType: 'image/webp', createdAt: '2026-08-03T00:00:00Z', sortOrder: 0 } });
  });

  it('persists primary selection and displays unauthorized errors', () => {
    const app = fixture.componentInstance as any;
    const photo = { id: 'photo-1', carId: 'car-1', objectKey: 'photo-1.webp', contentType: 'image/webp', createdAt: '2026-08-03T00:00:00Z', sortOrder: 0 };
    app.photos.set([photo]);
    app.designatePrimary(photo);
    const request = http.expectOne('/api/v1/cars/car-1/photos/photo-1');
    expect(request.request.body).toEqual({ isPrimary: true });
    expect(request.request.withCredentials).toBe(true);
    request.flush({ error: 'Authentication required' }, { status: 401, statusText: 'Unauthorized' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('session has expired');
  });

  it('reorders photos through authenticated per-photo updates', async () => {
    const app = fixture.componentInstance as any;
    const first = { id: 'photo-1', carId: 'car-1', objectKey: 'one.webp', contentType: 'image/webp', createdAt: '2026-08-03T00:00:00Z', sortOrder: 0 };
    const second = { id: 'photo-2', carId: 'car-1', objectKey: 'two.webp', contentType: 'image/webp', createdAt: '2026-08-03T00:00:00Z', sortOrder: 1 };
    app.photos.set([first, second]);
    app.move(second, -1);
    const requests = http.match((request) => request.method === 'PATCH');
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.request.body)).toEqual([{ sortOrder: 0 }, { sortOrder: 1 }]);
    requests.forEach((request) => request.flush({ photo: request.request.url.includes('photo-2') ? { ...second, sortOrder: 0 } : { ...first, sortOrder: 1 } }));
    await Promise.resolve();
    expect(app.photos()[0].id).toBe('photo-2');
  });
});
