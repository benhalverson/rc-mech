import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { Meta, Title } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppearanceService } from '../appearance.service';
import { LANDING_DESCRIPTION, LANDING_TITLE, Landing } from './landing';

class FakeAppearanceService {
	readonly resolved = signal<'light' | 'dark'>('light');
}

describe('Landing', () => {
	let fixture: ComponentFixture<Landing>;
	let appearance: FakeAppearanceService;
	let title: Title;
	let meta: Meta;

	beforeEach(async () => {
		appearance = new FakeAppearanceService();
		await TestBed.configureTestingModule({
			imports: [Landing],
			providers: [
				provideRouter([]),
				{ provide: AppearanceService, useValue: appearance },
			],
		}).compileComponents();
		title = TestBed.inject(Title);
		meta = TestBed.inject(Meta);
		fixture = TestBed.createComponent(Landing);
		fixture.detectChanges();
	});

	afterEach(() => TestBed.resetTestingModule());

	it('renders approved copy, access actions, and metadata', () => {
		const root = fixture.nativeElement as HTMLElement;
		expect(root.textContent).toContain('A field notebook for RC racers');
		expect(root.textContent).toContain(
			'Know what’s on the car. What changed. What happened next.',
		);
		expect(root.textContent).toContain(
			'An invite is required for first registration.',
		);
		expect(
			root.querySelector<HTMLAnchorElement>('a[href="/garage"]')?.textContent,
		).toContain('Enter Chassis Notes');
		expect(root.querySelector('a[href="/sign-in"]')).toBeTruthy();
		expect(root.querySelector('img')?.getAttribute('alt')).toContain(
			'Club carpet baseline, ride height, and front and rear camber',
		);
		expect(root.textContent).toContain('Start with what’s on the car.');
		expect(root.textContent).toContain('Club carpet baseline');
		expect(root.textContent).toContain('13 mm');
		expect(root.textContent).toContain('-1° / -1°');
		expect(root.textContent).toContain('35 wt / 30 wt');
		expect(root.textContent).toContain('30k');
		expect(root.textContent).toContain(
			'Team Associated RC10B7 · 1/10-scale electric 2WD buggy · carpet.',
		);
		expect(root.textContent).toContain('Change the setup. Keep the baseline.');
		expect(root.textContent).toContain('Changes from previous');
		expect(
			root
				.querySelector(
					'[role="group"][aria-label="Recorded rear shock-oil change"]',
				)
				?.querySelector('.sr-only')?.textContent,
		).toBe('Rear shock oil changed from 30 wt to 35 wt.');
		expect(root.textContent).toContain('not a recommended setup');
		expect(root.textContent).toContain('No performance outcome is claimed.');
		expect(title.getTitle()).toBe(LANDING_TITLE);
		expect(meta.getTag('name="description"')?.content).toBe(
			LANDING_DESCRIPTION,
		);
	});

	it('matches hero evidence to the resolved appearance', () => {
		const root = fixture.nativeElement as HTMLElement;
		const currentSetup = root.querySelector<HTMLImageElement>(
			'img[alt^="Chassis Notes Current setup for the B7 carpet car"]',
		);
		const setupHistory = root.querySelector<HTMLImageElement>(
			'img[alt^="Chassis Notes Setup history"]',
		);
		expect(currentSetup?.getAttribute('src')).toContain(
			'current-setup-mobile-light.png',
		);
		expect(setupHistory?.getAttribute('src')).toContain(
			'setup-history-desktop-light.png',
		);

		appearance.resolved.set('dark');
		fixture.detectChanges();
		expect(currentSetup?.getAttribute('src')).toContain(
			'current-setup-mobile-dark.png',
		);
		expect(setupHistory?.getAttribute('src')).toContain(
			'setup-history-desktop-dark.png',
		);
	});

	it('moves keyboard focus to the walkthrough without animated scrolling', () => {
		const root = fixture.nativeElement as HTMLElement;
		const walkthrough = root.querySelector('#walkthrough') as HTMLElement;
		walkthrough.scrollIntoView = vi.fn();
		const link = root.querySelector(
			'a[href="#walkthrough"]',
		) as HTMLAnchorElement;

		link.click();

		expect(document.activeElement).toBe(walkthrough);
		expect(walkthrough.scrollIntoView).toHaveBeenCalledWith({
			behavior: 'auto',
			block: 'start',
		});
	});
});
