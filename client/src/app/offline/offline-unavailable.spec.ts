import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, expect, it } from 'vitest';
import { OfflineUnavailable } from './offline-unavailable';

afterEach(() => TestBed.resetTestingModule());
it('explains the limitation and provides a native link to the offline Garage', () => {
	TestBed.configureTestingModule({ providers: [provideRouter([])] });
	const fixture = TestBed.createComponent(OfflineUnavailable);
	fixture.detectChanges();
	expect(fixture.nativeElement.querySelector('h1').textContent).toBe(
		'Connection needed',
	);
	expect(fixture.nativeElement.textContent).toContain('Reconnect to open it.');
	expect(fixture.nativeElement.querySelector('a').getAttribute('href')).toBe(
		'/garage',
	);
});
