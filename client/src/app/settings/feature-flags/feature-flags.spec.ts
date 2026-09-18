import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureFlagStore } from './feature-flag-store';
import { FeatureFlags } from './feature-flags';

describe('FeatureFlags', () => {
	afterEach(() => TestBed.resetTestingModule());
	it('renders Owner-only confirmed state and accessible save feedback', () => {
		const isOwner = signal(false);
		const enabled = signal<boolean | null>(null);
		const status = signal('idle');
		const save = vi.fn();
		TestBed.configureTestingModule({
			providers: [
				{
					provide: FeatureFlagStore,
					useValue: { isOwner, enabled, status, save },
				},
			],
		});
		const fixture = TestBed.createComponent(FeatureFlags);
		const root: HTMLElement = fixture.nativeElement;
		fixture.detectChanges();
		expect(root.querySelector('section')).toBeNull();
		isOwner.set(true);
		fixture.detectChanges();
		expect(root.querySelector('input')).toBeNull();
		expect(root.textContent).toContain('unavailable');
		enabled.set(false);
		fixture.detectChanges();
		const toggle = root.querySelector('input');
		if (!toggle) throw new Error('Missing toggle');
		toggle.click();
		fixture.detectChanges();
		expect(save).toHaveBeenCalledWith({ enabled: true });
		expect(toggle.checked).toBe(false);
		status.set('pending');
		fixture.detectChanges();
		expect(toggle.disabled).toBe(true);
		expect(root.querySelector('[role="status"]')?.textContent).toContain(
			'Saving',
		);
		status.set('failed');
		fixture.detectChanges();
		expect(toggle.checked).toBe(false);
		expect(toggle.disabled).toBe(false);
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'could not be saved',
		);
		enabled.set(true);
		status.set('succeeded');
		fixture.detectChanges();
		expect(toggle.checked).toBe(true);
		expect(root.querySelector('[role="status"]')?.textContent).toContain(
			'saved',
		);
		toggle.click();
		expect(save).toHaveBeenLastCalledWith({ enabled: false });
		expect(toggle.checked).toBe(true);
	});
});
