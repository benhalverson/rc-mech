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
		expect(title.getTitle()).toBe(LANDING_TITLE);
		expect(meta.getTag('name="description"')?.content).toBe(
			LANDING_DESCRIPTION,
		);
	});

	it('matches hero evidence to the resolved appearance', () => {
		const root = fixture.nativeElement as HTMLElement;
		expect(root.querySelector('img')?.getAttribute('src')).toContain(
			'current-setup-mobile-light.png',
		);

		appearance.resolved.set('dark');
		fixture.detectChanges();
		expect(root.querySelector('img')?.getAttribute('src')).toContain(
			'current-setup-mobile-dark.png',
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
