import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { provideRouter, withDisabledInitialNavigation } from '@angular/router';
import { App } from './app';
import { OwnerSessionStore } from './owner-session-store';

describe('App workspace shell', () => {
	let fixture: ComponentFixture<App>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [App],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([], withDisabledInitialNavigation()),
				provideNoopAnimations(),
				OwnerSessionStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
	});

	afterEach(() => http.verify());

	it('renders the public route outlet while signed out', async () => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush(null);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('router-outlet')).toBeTruthy();
		expect(fixture.nativeElement.querySelector('main')).toBeFalsy();
	});

	it('renders exactly one authenticated shell and main landmark', async () => {
		fixture = TestBed.createComponent(App);
		fixture.detectChanges();
		http.expectOne('/api/auth/get-session').flush({
			session: { id: 'session-1' },
			user: { email: 'owner@example.test' },
		});
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelectorAll('.workspace-shell')).toHaveLength(1);
		expect(fixture.nativeElement.querySelectorAll('.nav-toggle')).toHaveLength(1);
		expect(fixture.nativeElement.querySelectorAll('nav[aria-label="Primary workspace"]')).toHaveLength(1);
		expect(fixture.nativeElement.querySelectorAll('main')).toHaveLength(1);
	});
});
