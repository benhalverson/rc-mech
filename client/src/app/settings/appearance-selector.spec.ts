import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	AppearanceService,
	type AppearancePreference,
} from '../appearance.service';
import { AppearanceSelector } from './appearance-selector';

class FakeAppearanceService {
	readonly preference = signal<AppearancePreference>('system');
	readonly resolved = signal<'light' | 'dark'>('light');
	readonly persistenceAvailable = signal(true);
	readonly setAppearance = vi.fn((preference: AppearancePreference) => {
		this.preference.set(preference);
		this.resolved.set(preference === 'system' ? 'light' : preference);
	});
}

describe('AppearanceSelector', () => {
	let fixture: ComponentFixture<AppearanceSelector>;
	let appearance: FakeAppearanceService;

	beforeEach(async () => {
		appearance = new FakeAppearanceService();
		await TestBed.configureTestingModule({
			imports: [AppearanceSelector],
			providers: [{ provide: AppearanceService, useValue: appearance }],
		}).compileComponents();
		fixture = TestBed.createComponent(AppearanceSelector);
		fixture.detectChanges();
	});

	afterEach(() => TestBed.resetTestingModule());

	it('renders the current preference and synchronously dispatches a choice', () => {
		const root = fixture.nativeElement as HTMLElement;
		expect(root.querySelectorAll('svg')).toHaveLength(3);
		expect(
			root
				.querySelector('[data-route-focus][tabindex="-1"]')
				?.getAttribute('id'),
		).toBe('appearance-title');
		expect(
			(root.querySelector('input[value="system"]') as HTMLInputElement).checked,
		).toBe(true);
		expect(root.textContent).toContain('Currently using light appearance.');

		const choices = ['light', 'dark', 'system'] as const;
		for (const choice of choices) {
			const input = root.querySelector(
				`input[value="${choice}"]`,
			) as HTMLInputElement;
			input.dispatchEvent(new Event('change'));
			fixture.detectChanges();
			expect(input.checked).toBe(true);
		}

		const dark = root.querySelector('input[value="dark"]') as HTMLInputElement;
		dark.dispatchEvent(new Event('change'));
		fixture.detectChanges();

		expect(
			appearance.setAppearance.mock.calls.map(([choice]) => choice),
		).toEqual(['light', 'dark', 'system', 'dark']);
		expect(dark.checked).toBe(true);
		expect(root.textContent).toContain('Currently using dark appearance.');
	});

	it('explains when a choice cannot be persisted', () => {
		const root = fixture.nativeElement as HTMLElement;
		expect(root.textContent).not.toContain('Storage unavailable');

		appearance.persistenceAvailable.set(false);
		fixture.detectChanges();

		expect(root.querySelector('.alloy-attention-state')).not.toBeNull();
		expect(root.querySelector('svg[lucidetrianglealert]')).not.toBeNull();
		expect(root.textContent).toContain('Attention');
		expect(root.textContent).toContain('Storage unavailable');
		expect(root.textContent).toContain('cannot be saved on this device');
	});
});
