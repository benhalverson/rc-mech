import {
	computed,
	createEnvironmentInjector,
	EnvironmentInjector,
	runInInjectionContext,
	signal,
} from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router, UrlTree } from '@angular/router';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { drivingAnalysisCanMatch } from './visibility.guard';
import { VisibilityStore } from './visibility-store';

describe('Driving analysis routing boundary', () => {
	afterEach(() => TestBed.resetTestingModule());
	it.each([true, false])(
		'waits for visibility before allowing or redirecting: %s',
		async (allowed) => {
			const pending = signal(true);
			const resolution = computed(() => ({
				status: pending() ? 'pending' : 'succeeded',
			}));
			TestBed.configureTestingModule({
				providers: [
					provideRouter([]),
					{
						provide: VisibilityStore,
						useValue: { resolution, pending, visible: () => allowed },
					},
				],
			});
			const completed = vi.fn();
			const result = TestBed.runInInjectionContext(() =>
				drivingAnalysisCanMatch(),
			);
			const completion = firstValueFrom(result).then(completed);
			await Promise.resolve();
			expect(completed).not.toHaveBeenCalled();
			pending.set(false);
			await completion;
			if (allowed) expect(completed).toHaveBeenCalledWith(true);
			else {
				const destination = completed.mock.calls[0]?.[0];
				expect(destination).toBeInstanceOf(UrlTree);
				expect(TestBed.inject(Router).serializeUrl(destination)).toBe(
					'/garage',
				);
			}
		},
	);
	it('releases watchers after repeated completion, cancellation, and injector teardown', () => {
		const pending = signal(false);
		const session = signal('first');
		const read = vi.fn();
		const resolution = () => {
			read(session());
			return { status: pending() ? 'pending' : 'succeeded' };
		};
		TestBed.configureTestingModule({
			providers: [
				provideRouter([]),
				{
					provide: VisibilityStore,
					useValue: {
						resolution,
						pending,
						visible: () => session() === 'first',
					},
				},
			],
		});
		for (let navigation = 0; navigation < 10; navigation++) {
			const complete = vi.fn();
			TestBed.runInInjectionContext(() => drivingAnalysisCanMatch()).subscribe({
				complete,
			});
			TestBed.tick();
			expect(complete).toHaveBeenCalledOnce();
		}
		expect(read).toHaveBeenCalledTimes(10);
		session.set('second');
		TestBed.tick();
		expect(read).toHaveBeenCalledTimes(10);
		const queued = TestBed.runInInjectionContext(() =>
			drivingAnalysisCanMatch(),
		).subscribe();
		queued.unsubscribe();
		TestBed.tick();
		expect(read).toHaveBeenCalledTimes(10);
		pending.set(true);
		const cancelled = TestBed.runInInjectionContext(() =>
			drivingAnalysisCanMatch(),
		).subscribe();
		TestBed.tick();
		cancelled.unsubscribe();
		const injector = createEnvironmentInjector(
			[],
			TestBed.inject(EnvironmentInjector),
		);
		const complete = vi.fn();
		runInInjectionContext(injector, () => drivingAnalysisCanMatch()).subscribe({
			complete,
		});
		TestBed.tick();
		injector.destroy();
		expect(complete).toHaveBeenCalledOnce();
		read.mockClear();
		pending.set(false);
		session.set('third');
		TestBed.tick();
		expect(read).not.toHaveBeenCalled();
	});

	it('gates a pending navigation using the new session visibility', async () => {
		const session = signal('first');
		const pending = signal(true);
		TestBed.configureTestingModule({
			providers: [
				provideRouter([]),
				{
					provide: VisibilityStore,
					useValue: {
						resolution: computed(() => ({
							session: session(),
							pending: pending(),
						})),
						pending,
						visible: () => session() === 'first',
					},
				},
			],
		});
		const result = firstValueFrom(
			TestBed.runInInjectionContext(() => drivingAnalysisCanMatch()),
		);
		TestBed.tick();
		session.set('second');
		pending.set(false);
		const destination = await result;
		expect(destination).toBeInstanceOf(UrlTree);
		if (destination instanceof UrlTree)
			expect(TestBed.inject(Router).serializeUrl(destination)).toBe('/garage');
	});
});
