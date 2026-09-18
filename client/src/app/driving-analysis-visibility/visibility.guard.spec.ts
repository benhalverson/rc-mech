import { computed, signal } from '@angular/core';
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
});
