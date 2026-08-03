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
    fixture.detectChanges();
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
