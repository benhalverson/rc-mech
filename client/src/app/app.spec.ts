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
    http.match('/api/v1/maintenance-plans').forEach((request) => request.flush({ maintenancePlans: [], activity: [] }));
    http.match((request) => request.url.endsWith('/service-records') && request.method === 'GET').forEach((request) => request.flush({ serviceRecords: [] }));
    http.match((request) => request.url.endsWith('/photos') && request.method === 'GET').forEach((request) => request.flush({ photos: [] }));
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
    http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'America/Los_Angeles' });
    fixture.detectChanges();
  };

  const flushDriveSessions = (sessions: unknown[] = []) => {
    http.expectOne((request) => request.url === '/api/v1/cars/car-1/drives' && request.params.get('history') === 'true')
      .flush({ driveSessions: sessions });
  };

  const workshopCar = {
    id: 'car-1', name: 'Red Runner', make: 'Associated', model: 'B6.4', scale: '1/10',
    vehicleType: 'Buggy', powerType: 'Electric', notes: 'Fresh diff oil', createdAt: '2026-08-01T00:00:00.000Z', archivedAt: null,
  };

  const currentMotor = {
    id: 'component-2', carId: 'car-1', slot: 'motor', slotType: 'standard', name: 'Competition motor',
    manufacturer: 'Reedy', model: 'M3', serialNumber: 'M-002', notes: 'Fresh bearings',
    installedAt: '2026-08-02T00:00:00.000Z', removedAt: null,
  };

  const previousMotor = {
    id: 'component-1', carId: 'car-1', slot: 'motor', slotType: 'standard', name: 'Practice motor',
    manufacturer: 'Reedy', model: 'M2', serialNumber: 'M-001', notes: 'Retired after race day',
    installedAt: '2026-07-01T00:00:00.000Z', removedAt: '2026-08-02T00:00:00.000Z',
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
    const previousPublicKeyCredential = Object.getOwnPropertyDescriptor(globalThis, 'PublicKeyCredential');
    const previousSecureContext = Object.getOwnPropertyDescriptor(window, 'isSecureContext');
    const previousCredentials = Object.getOwnPropertyDescriptor(navigator, 'credentials');
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
    http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'America/Los_Angeles' });
    await fixture.whenStable();
    if (previousPublicKeyCredential) Object.defineProperty(globalThis, 'PublicKeyCredential', previousPublicKeyCredential);
    else delete (globalThis as any).PublicKeyCredential;
    if (previousSecureContext) Object.defineProperty(window, 'isSecureContext', previousSecureContext);
    else delete (window as any).isSecureContext;
    if (previousCredentials) Object.defineProperty(navigator, 'credentials', previousCredentials);
    else delete (navigator as any).credentials;
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

  it('loads a car build sheet with current installations and replacement history', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).openCar(workshopCar);
    const request = http.expectOne((req) => req.url === '/api/v1/cars/car-1/components' && req.params.get('history') === 'true');
    request.flush({ components: [currentMotor, previousMotor], history: true });
    flushDriveSessions();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('Competition motor');
    expect(fixture.nativeElement.textContent).toContain('Reedy');
    expect(fixture.nativeElement.textContent).toContain('Previous installations (1)');
    expect(fixture.nativeElement.textContent).toContain('Practice motor');
  });

  it('adds a custom-slot component using the explicit build-sheet contract', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).openCar(workshopCar);
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components').flush({ components: [], history: true });
    flushDriveSessions();
    fixture.detectChanges();

    (fixture.componentInstance as any).openAddComponent();
    (fixture.componentInstance as any).componentForm.set({
      slotType: 'custom', slot: 'front-sway-bar', name: 'Sway bar', manufacturer: 'XRAY', model: 'T1', serialNumber: 'SB-7', notes: 'Medium rate',
    });
    (fixture.componentInstance as any).saveComponent();
    const request = http.expectOne('/api/v1/cars/car-1/components');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toEqual({
      slotType: 'custom', slot: 'front-sway-bar', name: 'Sway bar', manufacturer: 'XRAY', model: 'T1', serialNumber: 'SB-7', notes: 'Medium rate',
    });
    request.flush({ component: { ...currentMotor, slot: 'front-sway-bar', slotType: 'custom', name: 'Sway bar' } });
    const reload = http.expectOne((req) => req.url === '/api/v1/cars/car-1/components' && req.params.get('history') === 'true');
    reload.flush({ components: [{ ...currentMotor, slot: 'front-sway-bar', slotType: 'custom', name: 'Sway bar' }], history: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('front-sway-bar');
  });

  it('records, edits, archives, and counts drive sessions in the run log', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).openCar(workshopCar);
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components').flush({ components: [], history: true });
    flushDriveSessions();
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.session-log .section-heading .button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).sessionForm.set({
      startedAt: '2026-08-03T10:30', durationMinutes: '45', conditions: 'Dry clay', notes: 'Rear grip felt good',
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.session-form') as HTMLFormElement).dispatchEvent(new Event('submit'));

    const create = http.expectOne('/api/v1/cars/car-1/drives');
    expect(create.request.method).toBe('POST');
    expect(create.request.body).toEqual({
      startedAt: '2026-08-03T17:30:00.000Z', durationMinutes: 45, conditions: 'Dry clay', notes: 'Rear grip felt good',
    });
    const saved = { id: 'drive-1', carId: 'car-1', startedAt: '2026-08-03T17:30:00.000Z', durationMinutes: 45, conditions: 'Dry clay', notes: 'Rear grip felt good', deletedAt: null };
    create.flush({ driveSession: saved });
    flushDriveSessions([saved]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('1 recorded session');
    expect(fixture.nativeElement.textContent).toContain('Dry clay');
    expect(fixture.nativeElement.textContent).toContain('Aug 3, 2026');

    (fixture.nativeElement.querySelector('.session-row .text-button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).sessionForm.update((form: Record<string, string>) => ({ ...form, notes: 'Updated setup' }));
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.session-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const edit = http.expectOne('/api/v1/cars/car-1/drives/drive-1');
    expect(edit.request.method).toBe('PATCH');
    expect(edit.request.body.notes).toBe('Updated setup');
    edit.flush({ driveSession: { ...saved, notes: 'Updated setup' } });
    flushDriveSessions([{ ...saved, notes: 'Updated setup' }]);
    fixture.detectChanges();

    (fixture.nativeElement.querySelector('.session-row .danger') as HTMLButtonElement).click();
    const remove = http.expectOne('/api/v1/cars/car-1/drives/drive-1');
    expect(remove.request.method).toBe('DELETE');
    remove.flush({ driveSession: { ...saved, deletedAt: '2026-08-03T18:00:00.000Z' } });
    flushDriveSessions([{ ...saved, notes: 'Updated setup', deletedAt: '2026-08-03T18:00:00.000Z' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Archived from active history');
  });

  it('saves an IANA timezone and uses it for session display', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).timezoneForm.set('America/New_York');
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.timezone-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const request = http.expectOne('/api/v1/preferences/timezone');
    expect(request.request.method).toBe('PATCH');
    expect(request.request.body).toEqual({ timezone: 'America/New_York' });
    request.flush({ timezone: 'America/New_York' });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('America/New_York');
  });

  it('keeps archived session history visible but blocks new sessions', () => {
    createFixture();
    showSignedIn();
    const archivedCar = { ...workshopCar, archivedAt: '2026-08-03T00:00:00.000Z' };
    (fixture.componentInstance as any).cars.set([archivedCar]);
    (fixture.componentInstance as any).openCar(archivedCar);
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components').flush({ components: [], history: true });
    const archived = { id: 'drive-1', carId: 'car-1', startedAt: '2026-08-02T17:00:00.000Z', notes: 'Race day', deletedAt: null };
    flushDriveSessions([archived]);
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Race day');
    expect(fixture.nativeElement.textContent).toContain('new sessions cannot be recorded');
    expect(fixture.nativeElement.querySelector('.session-log .section-heading .button')).toBeNull();
  });

  it('edits current details and replaces through separate lifecycle endpoints', () => {
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).openCar(workshopCar);
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components').flush({ components: [currentMotor, previousMotor], history: true });
    flushDriveSessions();

    (fixture.componentInstance as any).openEditComponent(currentMotor);
    (fixture.componentInstance as any).componentForm.update((form: Record<string, string>) => ({ ...form, model: 'M3 Pro' }));
    (fixture.componentInstance as any).saveComponent();
    const edit = http.expectOne('/api/v1/cars/car-1/components/component-2');
    expect(edit.request.method).toBe('PATCH');
    expect(edit.request.body).toEqual({ name: 'Competition motor', manufacturer: 'Reedy', model: 'M3 Pro', serialNumber: 'M-002', notes: 'Fresh bearings' });
    edit.flush({ component: { ...currentMotor, model: 'M3 Pro' } });
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components' && req.params.get('history') === 'true').flush({ components: [{ ...currentMotor, model: 'M3 Pro' }, previousMotor], history: true });

    (fixture.componentInstance as any).openReplaceComponent({ ...currentMotor, model: 'M3 Pro' });
    (fixture.componentInstance as any).componentForm.update((form: Record<string, string>) => ({ ...form, name: 'New motor', manufacturer: 'Muchmore', model: 'Fleta' }));
    (fixture.componentInstance as any).saveComponent();
    const replace = http.expectOne('/api/v1/cars/car-1/components/component-2/replace');
    expect(replace.request.method).toBe('POST');
    expect(replace.request.body.slotType).toBe('standard');
    replace.flush({ previous: { ...currentMotor, removedAt: '2026-08-03T00:00:00.000Z' }, component: { ...currentMotor, id: 'component-3', name: 'New motor', removedAt: null } });
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components' && req.params.get('history') === 'true').flush({ components: [{ ...currentMotor, id: 'component-3', name: 'New motor' }, previousMotor, { ...currentMotor, removedAt: '2026-08-03T00:00:00.000Z' }], history: true });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('New motor');
    expect(fixture.nativeElement.textContent).toContain('previous installation');
  });

  it('keeps archived build sheets visible but blocks component writes', () => {
    createFixture();
    showSignedIn();
    const archivedCar = { ...workshopCar, archivedAt: '2026-08-03T00:00:00.000Z' };
    (fixture.componentInstance as any).cars.set([archivedCar]);
    (fixture.componentInstance as any).openCar(archivedCar);
    http.expectOne((req) => req.url === '/api/v1/cars/car-1/components').flush({ components: [currentMotor], history: true });
    flushDriveSessions();
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('read-only while the car is archived');
    expect(fixture.nativeElement.querySelector('.build-sheet .button')).toBeNull();
    (fixture.componentInstance as any).openAddComponent('motor');
    expect((fixture.componentInstance as any).componentEditing()).toBe(false);
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
    http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'America/Los_Angeles' });
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

  it('loads component history and supports adding and replacing an installation', () => {
    const current = {
      id: 'component-2', carId: 'car-1', slot: 'motor', slotType: 'standard', name: 'Motor v2',
      manufacturer: 'Tekin', model: 'RX8', serialNumber: 'new-2', notes: 'Fresh install',
      installedAt: '2026-08-02T00:00:00.000Z', removedAt: null,
    };
    const previous = {
      id: 'component-1', carId: 'car-1', slot: 'motor', slotType: 'standard', name: 'Motor v1',
      manufacturer: 'Tekin', model: 'RX4', serialNumber: 'old-1', notes: 'Original',
      installedAt: '2026-07-01T00:00:00.000Z', removedAt: '2026-08-02T00:00:00.000Z',
    };
    createFixture();
    showSignedIn();
    (fixture.componentInstance as any).cars.set([workshopCar]);
    (fixture.componentInstance as any).openCar(workshopCar);
    fixture.detectChanges();
    const historyRequest = http.expectOne((request) =>
      request.url === '/api/v1/cars/car-1/components' && request.params.get('history') === 'true');
    historyRequest.flush({ components: [current, previous] });
    flushDriveSessions();
    fixture.detectChanges();

    expect(fixture.nativeElement.querySelector('.component-current')?.textContent).toContain('Tekin');
    expect(fixture.nativeElement.querySelector('.component-history')).toBeTruthy();

    (fixture.nativeElement.querySelector('.build-sheet .section-heading .button') as HTMLButtonElement).click();
    (fixture.componentInstance as any).componentForm.set({
      slotType: 'custom', slot: 'front-sway-bar', name: 'Sway bar', manufacturer: 'RPM', model: 'X1', serialNumber: 'custom-1', notes: 'Custom fit',
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.component-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const add = http.expectOne('/api/v1/cars/car-1/components');
    expect(add.request.body).toMatchObject({ slotType: 'custom', slot: 'front-sway-bar', manufacturer: 'RPM', model: 'X1' });
    add.flush({ component: { ...current, id: 'component-3', slot: 'front-sway-bar', slotType: 'custom', name: 'Sway bar' } });
    http.expectOne((request) => request.url === '/api/v1/cars/car-1/components' && request.params.get('history') === 'true')
      .flush({ components: [current, previous, { id: 'component-3', carId: 'car-1', slot: 'front-sway-bar', slotType: 'custom', name: 'Sway bar', removedAt: null }] });
    fixture.detectChanges();

    (fixture.componentInstance as any).components.set([current, previous]);
    (fixture.componentInstance as any).openReplaceComponent(current);
    (fixture.componentInstance as any).componentForm.set({
      slotType: 'standard', slot: 'motor', name: 'Motor v3', manufacturer: 'Tekin', model: 'RX9', serialNumber: 'new-3', notes: 'Replaced',
    });
    fixture.detectChanges();
    (fixture.nativeElement.querySelector('.component-form') as HTMLFormElement).dispatchEvent(new Event('submit'));
    const replace = http.expectOne('/api/v1/cars/car-1/components/component-2/replace');
    expect(replace.request.body).toMatchObject({ slotType: 'standard', model: 'RX9' });
    replace.flush({ component: { ...current, id: 'component-4', name: 'Motor v3' }, previous });
    http.expectOne((request) => request.url === '/api/v1/cars/car-1/components' && request.params.get('history') === 'true')
      .flush({ components: [previous, current, { ...current, id: 'component-4', name: 'Motor v3', removedAt: null }] });
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
