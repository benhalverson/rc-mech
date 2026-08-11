import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { OfflineStatus } from './offline-status';
import { OfflineWorkspaceStore } from './offline-workspace-store';

class FakeOfflineWorkspaceStore {
	readonly status = signal<
		| 'idle'
		| 'preparing'
		| 'ready'
		| 'offline'
		| 'offline-unavailable'
		| 'online-only'
	>('idle');
	readonly message = signal('');
}

describe('OfflineStatus', () => {
	let fixture: ComponentFixture<OfflineStatus>;
	let store: FakeOfflineWorkspaceStore;

	beforeEach(async () => {
		store = new FakeOfflineWorkspaceStore();
		await TestBed.configureTestingModule({
			imports: [OfflineStatus],
			providers: [{ provide: OfflineWorkspaceStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(OfflineStatus);
		fixture.detectChanges();
	});

	afterEach(() => TestBed.resetTestingModule());

	it('announces readiness and outage without creating a focus target', () => {
		expect(fixture.nativeElement.querySelector('[role="status"]')).toBeNull();

		for (const [status, message] of [
			['preparing', 'Preparing offline access…'],
			['ready', 'Offline ready'],
			[
				'offline',
				'Offline—changes will be saved here and sync when connection returns.',
			],
			['offline-unavailable', 'Offline—this browser has no prepared Garage.'],
			[
				'online-only',
				'Offline access is unavailable in this browser. Chassis Notes remains available while connected.',
			],
		] as const) {
			store.status.set(status);
			store.message.set(message);
			fixture.detectChanges();
			const rendered = fixture.nativeElement.querySelector(
				'[role="status"]',
			) as HTMLElement;
			expect(rendered.textContent).toContain(message);
			expect(rendered.getAttribute('aria-live')).toBe('polite');
			expect(rendered.hasAttribute('tabindex')).toBe(false);
			expect(rendered.dataset['offlineStatus']).toBe(status);
		}
	});
});
