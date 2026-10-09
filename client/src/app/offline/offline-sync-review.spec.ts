import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it, vi } from 'vitest';
import { OfflineSyncReview } from './offline-sync-review';
import type { SyncReview } from './offline-sync-review.models';
import { syncReviewFixtures } from './offline-sync-review.testing';
import { OfflineSyncReviewStore } from './offline-sync-review-store';

afterEach(() => TestBed.resetTestingModule());
it('shows readable device and saved versions and invokes an explicit recovery choice', () => {
	const reviews = signal<readonly SyncReview[]>([]),
		error = signal('');
	const resolve = vi.fn();
	TestBed.configureTestingModule({
		imports: [OfflineSyncReview],
		providers: [
			{
				provide: OfflineSyncReviewStore,
				useValue: {
					reviews,
					error,
					pending: signal(false),
					names: () => ({}),
					resolve,
				},
			},
		],
	});
	const fixture = TestBed.createComponent(OfflineSyncReview);
	fixture.detectChanges();
	expect(fixture.nativeElement.querySelector('section')).toBeNull();
	const review = syncReviewFixtures[0];
	reviews.set([review]);
	fixture.detectChanges();
	const root = fixture.nativeElement as HTMLElement;
	expect(root.textContent).toContain('Device name');
	expect(root.textContent).toContain('Saved name');
	expect(root.textContent).not.toContain('baseVersion');
	const buttons = root.querySelectorAll('button');
	buttons[0].click();
	buttons[1].click();
	expect(resolve.mock.calls).toEqual([
		[review, 'device'],
		[review, 'remote'],
	]);
	reviews.set([
		{
			...review,
			operation: { ...review.operation, status: 'needs-attention' },
		} as SyncReview,
	]);
	error.set('Storage unavailable');
	fixture.detectChanges();
	expect(root.textContent).toContain('Needs attention');
	expect(root.querySelector('[role="alert"]')?.textContent).toContain(
		'Storage unavailable',
	);
});
