import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  let fixture: ComponentFixture<App>;
  let http: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();

    http = TestBed.inject(HttpTestingController);
  });

  afterEach(() => {
    http.verify();
    window.history.replaceState({}, '', '/');
  });

  const createFixture = () => {
    fixture = TestBed.createComponent(App);
  };

  const showSignedOut = () => {
    http.expectOne('/api/auth/get-session').flush(null);
    fixture.detectChanges();
  };

  const showSignedIn = () => {
    http.expectOne('/api/auth/get-session').flush({
      session: { id: 'session-1' },
      user: { email: 'owner@example.test' },
    });
    http.expectOne('/api/v1/cars').flush({ cars: [] });
    http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
    fixture.detectChanges();
  };

  const workshopCar = {
    id: 'car-1', name: 'Red Runner', make: 'Associated', model: 'B6.4', scale: '1/10',
    vehicleType: 'Buggy', powerType: 'Electric', notes: 'Fresh diff oil', createdAt: '2026-08-01T00:00:00.000Z', archivedAt: null,
  };

  it('shows the owner magic-link screen when no session exists', () => {
    createFixture();
    showSignedOut();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Back to the');
    expect(fixture.nativeElement.querySelector('input[type="email"]')).toBeTruthy();
  });

  it('requests a magic link with the entered email and a same-origin callback', () => {
    createFixture();
    showSignedOut();

    (fixture.componentInstance as any).email.set('owner@example.test');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form button[type="submit"]') as HTMLButtonElement).click();

    const request = http.expectOne('/api/auth/sign-in/magic-link');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      email: 'owner@example.test',
      callbackURL: window.location.origin,
    });
    request.flush({ status: true });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain('If that address is allowed');
  });

  it('uses generic messaging when the magic-link request fails', () => {
    createFixture();
    showSignedOut();

    (fixture.componentInstance as any).email.set('not-owner@example.test');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('form button[type="submit"]') as HTMLButtonElement).click();
    http.expectOne('/api/auth/sign-in/magic-link').flush({ error: 'not allowed' }, { status: 403, statusText: 'Forbidden' });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('That request could not be completed');
    expect(fixture.nativeElement.textContent).not.toContain('not-owner@example.test');
  });

  it('signs in with a browser passkey through Better Auth endpoints', async () => {
    Object.defineProperty(globalThis, 'PublicKeyCredential', { configurable: true, value: class PublicKeyCredential {} });
    Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: { get: vi.fn().mockResolvedValue({
        id: 'credential-1',
        type: 'public-key',
        rawId: new Uint8Array([1, 2]).buffer,
        response: {
          clientDataJSON: new Uint8Array([3]).buffer,
          authenticatorData: new Uint8Array([4]).buffer,
          signature: new Uint8Array([5]).buffer,
          userHandle: null,
        },
        getClientExtensionResults: () => ({}),
      }) },
    });
    createFixture();
    showSignedOut();

    (fixture.nativeElement.querySelector('.passkey-button') as HTMLButtonElement).click();
    http.expectOne('/api/auth/passkey/generate-authenticate-options').flush({ challenge: 'AQ' });
    await fixture.whenStable();
    const verify = http.expectOne('/api/auth/passkey/verify-authentication');
    expect(verify.request.body.response.rawId).toBe('AQI');
    verify.flush({ session: { id: 'session-1' }, user: { email: 'owner@example.test' } });
    await fixture.whenStable();
    http.expectOne('/api/auth/get-session').flush({ session: { id: 'session-1' }, user: { email: 'owner@example.test' } });
    await fixture.whenStable();
    http.expectOne('/api/v1/cars').flush({ cars: [] });
    http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
    await fixture.whenStable();
  });

  it('lists, renames, and revokes a named passkey', async () => {
    createFixture();
    showSignedIn();

    const row = fixture.nativeElement.querySelector('.passkey-row') as HTMLElement;
    expect(row).toBeNull();
    (fixture.componentInstance as any).passkeys.set([{ id: 'pk-1', name: 'Workshop laptop', createdAt: '2026-08-01T00:00:00.000Z' }]);
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.passkey-row .text-button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).editedPasskeyName.set('Phone');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.rename-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const rename = http.expectOne('/api/auth/passkey/update-passkey');
    expect(rename.request.body).toEqual({ id: 'pk-1', name: 'Phone' });
    rename.flush({ passkey: { id: 'pk-1', name: 'Phone' } });
    await fixture.whenStable();
    http.expectOne('/api/auth/passkey/list-user-passkeys').flush([{ id: 'pk-1', name: 'Phone' }]);
    await fixture.whenStable();
    fixture.detectChanges();

    const buttons = fixture.nativeElement.querySelectorAll('.passkey-row .text-button');
    (buttons[1] as HTMLButtonElement).click();
    const revoke = http.expectOne('/api/auth/passkey/delete-passkey');
    expect(revoke.request.body).toEqual({ id: 'pk-1' });
    revoke.flush({ status: true });
    await fixture.whenStable();
    http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
  });

  it('renders the garage and signs out an authenticated owner', () => {
    createFixture();
    showSignedIn();

    expect(fixture.nativeElement.querySelector('h1')?.textContent).toContain('Garage control');
    expect(fixture.nativeElement.textContent).toContain('owner@example.test');

    (fixture.nativeElement.querySelector('button.quiet') as HTMLButtonElement).click();
    const request = http.expectOne('/api/auth/sign-out');
    expect(request.request.withCredentials).toBe(true);
    request.flush({ success: true });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('input[type="email"]')).toBeTruthy();
  });

  it('shows a useful empty garage state after loading', () => {
    createFixture();
    showSignedIn();

    expect(fixture.nativeElement.querySelector('.empty-state')?.textContent).toContain('garage is waiting');
    expect(fixture.nativeElement.textContent).toContain('Add the first car');
  });

  it('shows a loading state and recovers from a garage error', () => {
    createFixture();
    http.expectOne('/api/auth/get-session').flush({ session: { id: 'session-1' }, user: { email: 'owner@example.test' } });
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Opening the garage ledger');
    http.expectOne('/api/v1/cars').flush({ error: 'temporary failure' }, { status: 503, statusText: 'Unavailable' });
    http.expectOne('/api/auth/passkey/list-user-passkeys').flush([]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.error-state')?.textContent).toContain('garage could not be loaded');

    (fixture.nativeElement.querySelector('.error-state .text-button') as HTMLButtonElement).click();
    http.expectOne('/api/v1/cars').flush({ cars: [] });
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.empty-state')).toBeTruthy();
  });

  it('creates a car with the garage fields and returns to its detail view', () => {
    createFixture();
    showSignedIn();
    (fixture.nativeElement.querySelector('.garage-heading .button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).carForm.set({
      name: 'Red Runner', make: 'Associated', model: 'B6.4', scale: '1/10',
      vehicleType: 'Buggy', powerType: 'Electric', notes: 'Fresh diff oil',
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.car-form') as HTMLFormElement).dispatchEvent(new Event('submit'));

    const request = http.expectOne('/api/v1/cars');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      name: 'Red Runner', make: 'Associated', model: 'B6.4', scale: '1/10',
      vehicleType: 'Buggy', powerType: 'Electric', notes: 'Fresh diff oil',
    });
    request.flush({ car: workshopCar });
    http.expectOne('/api/v1/cars').flush({ cars: [workshopCar] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('#car-detail-title')?.textContent).toContain('Red Runner');
    expect(fixture.nativeElement.textContent).toContain('Fresh diff oil');
  });

  it('edits, archives, and restores a car while keeping archived records inspectable', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).selectedCarId.set('car-1');
    (fixture.componentInstance as any).carView.set('detail');
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.car-detail .button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).carForm.update((form: Record<string, string>) => ({ ...form, name: 'Red Runner v2' }));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.car-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const edit = http.expectOne('/api/v1/cars/car-1');
    expect(edit.request.method).toBe('PATCH');
    edit.flush({ car: { ...workshopCar, name: 'Red Runner v2' } });
    http.expectOne('/api/v1/cars').flush({ cars: [{ ...workshopCar, name: 'Red Runner v2' }] });
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.danger-button') as HTMLButtonElement).click();
    const archive = http.expectOne('/api/v1/cars/car-1/archive');
    expect(archive.request.withCredentials).toBe(true);
    const archivedCar = { ...workshopCar, name: 'Red Runner v2', archivedAt: '2026-08-03T00:00:00.000Z' };
    archive.flush({ car: archivedCar });
    const archivedList = http.expectOne((request) => request.url === '/api/v1/cars' && request.params.get('archived') === 'all');
    archivedList.flush({ cars: [archivedCar] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Out of rotation');
    expect(fixture.nativeElement.textContent).toContain('History remains available');

    (fixture.nativeElement.querySelector('.car-detail .button.quiet') as HTMLButtonElement).click();
    const restore = http.expectOne('/api/v1/cars/car-1/restore');
    restore.flush({ car: { ...archivedCar, archivedAt: null } });
    http.expectOne((request) => request.url === '/api/v1/cars' && request.params.get('archived') === 'all').flush({ cars: [{ ...archivedCar, archivedAt: null }] });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Ready to work on');
  });

  it('can inspect archived cars separately from the active garage', () => {
    createFixture();
    showSignedIn();
    (fixture.nativeElement.querySelector('.garage-toolbar .text-button') as HTMLButtonElement).click();
    const request = http.expectOne((req) => req.url === '/api/v1/cars' && req.params.get('archived') === 'all');
    request.flush({ cars: [{ ...workshopCar, archivedAt: '2026-07-01T00:00:00.000Z' }] });
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.car-row')?.textContent).toContain('Archived');
    expect(fixture.nativeElement.textContent).toContain('Show active cars');
  });

  it('shows a generic recovery message and removes callback errors from the URL', () => {
    window.history.replaceState({}, '', '/?error=invalid_token&error_description=expired&view=access');
    createFixture();
    showSignedOut();

    expect(fixture.nativeElement.querySelector('[role="status"]')?.textContent).toContain('That recovery link could not be used');
    expect(window.location.search).toBe('?view=access');
    expect(fixture.nativeElement.textContent).not.toContain('invalid_token');
    expect(fixture.nativeElement.textContent).not.toContain('expired');
  });
});
