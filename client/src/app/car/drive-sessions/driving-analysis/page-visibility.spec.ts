import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PageVisibilityCapability } from './page-visibility';

describe('PageVisibilityCapability', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('tracks browser visibility and removes its listener with the route', () => {
		let visibility: DocumentVisibilityState = 'visible';
		const document = new EventTarget() as EventTarget & {
			readonly visibilityState: DocumentVisibilityState;
		};
		Object.defineProperty(document, 'visibilityState', {
			get: () => visibility,
		});
		const removeEventListener = vi.spyOn(document, 'removeEventListener');
		TestBed.configureTestingModule({
			providers: [
				PageVisibilityCapability,
				{ provide: DOCUMENT, useValue: document },
			],
		});
		const capability = TestBed.inject(PageVisibilityCapability);
		expect(capability.hidden()).toBe(false);

		visibility = 'hidden';
		document.dispatchEvent(new Event('visibilitychange'));
		expect(capability.hidden()).toBe(true);

		TestBed.resetTestingModule();
		expect(removeEventListener).toHaveBeenCalledWith(
			'visibilitychange',
			expect.any(Function),
		);
	});

	it('starts hidden when the route opens in a background tab', () => {
		TestBed.configureTestingModule({
			providers: [
				PageVisibilityCapability,
				{
					provide: DOCUMENT,
					useValue: {
						visibilityState: 'hidden',
						addEventListener: vi.fn(),
						removeEventListener: vi.fn(),
					},
				},
			],
		});
		expect(TestBed.inject(PageVisibilityCapability).hidden()).toBe(true);
	});
});
