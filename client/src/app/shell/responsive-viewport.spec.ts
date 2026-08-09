import { BreakpointObserver, type BreakpointState } from '@angular/cdk/layout';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ResponsiveViewport } from './responsive-viewport';

describe('ResponsiveViewport', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('exposes breakpoint state and tears down its observer deterministically', () => {
		const states = new Subject<BreakpointState>();
		const disposed = vi.fn();
		const observe = vi.fn(
			() =>
				new Observable<BreakpointState>((subscriber) => {
					const subscription = states.subscribe(subscriber);
					return () => {
						disposed();
						subscription.unsubscribe();
					};
				}),
		);
		TestBed.configureTestingModule({
			providers: [
				ResponsiveViewport,
				{ provide: BreakpointObserver, useValue: { observe } },
			],
		});

		const viewport = TestBed.inject(ResponsiveViewport);
		expect(observe).toHaveBeenCalledWith('(max-width: 1023px)');
		expect(viewport.mobile()).toBe(false);
		states.next({ matches: true, breakpoints: {} });
		expect(viewport.mobile()).toBe(true);
		states.next({ matches: false, breakpoints: {} });
		expect(viewport.mobile()).toBe(false);

		TestBed.resetTestingModule();
		expect(disposed).toHaveBeenCalledOnce();
	});
});
