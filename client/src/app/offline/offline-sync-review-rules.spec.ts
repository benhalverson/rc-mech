import { expect, it } from 'vitest';
import type { SyncReview } from './offline-sync-review.models';
import {
	reviewedSetup,
	syncReviewFixtures,
} from './offline-sync-review.testing';
import { retryReviewedOperation } from './offline-sync-review-rules';

it('creates a fresh retry identity against reviewed evidence while preserving the requested device values', () => {
	for (const review of syncReviewFixtures) {
		const before = structuredClone(review);
		const retried = retryReviewedOperation(review, 'retry');
		expect(retried).toMatchObject({
			operationId: 'retry',
			status: 'pending',
			feedback: undefined,
			remote: undefined,
		});
		expect(review).toEqual(before);
		if ('baseVersion' in retried.command)
			expect(retried.command.baseVersion).toBe(review.family === 'car' ? 3 : 4);
		expect(
			retryReviewedOperation(
				{
					...review,
					operation: { ...review.operation, remote: undefined },
				} as SyncReview,
				'retry',
			).command,
		).toEqual(review.operation.command);
	}
});
it('retains exact reviewed Car values and archive state, including missing version metadata', () => {
	const original = syncReviewFixtures[0];
	if (original.family !== 'car') throw new Error('Fixture mismatch');
	const car = {
		...original,
		operation: {
			...original.operation,
			remote: { id: 'car', name: 'Saved' },
			command: {
				type: 'car.edit' as const,
				carId: 'car',
				baseVersion: 1,
				base: {},
				changes: { notes: 'New notes' },
			},
		},
	};
	expect(retryReviewedOperation(car, 'retry').command).toMatchObject({
		baseVersion: 0,
		base: { notes: null },
	});
	for (const archivedAt of [null, '2026-10-09'])
		expect(
			retryReviewedOperation(
				{
					...original,
					operation: {
						...original.operation,
						remote: { id: 'car', name: 'Saved', version: 5, archivedAt },
						command: {
							type: 'car.archive',
							carId: 'car',
							baseVersion: 1,
							base: { archivedAt: null },
						},
					},
				},
				'retry',
			).command,
		).toMatchObject({ base: { archivedAt } });
	expect(
		retryReviewedOperation(
			{
				...original,
				operation: {
					...original.operation,
					command: {
						type: 'car.create',
						carId: 'car',
						car: { name: 'Device' },
					},
				},
			},
			'retry',
		).command.type,
	).toBe('car.create');
});
it('rebases Setup selection and corrections without claiming a deleted Setup is available', () => {
	const original = syncReviewFixtures[1];
	if (original.family !== 'setup') throw new Error('Fixture mismatch');
	const remote = {
		setup: { ...reviewedSetup, version: undefined },
		currentSetupId: 'setup',
		currentSetupVersion: 7,
	};
	expect(
		retryReviewedOperation(
			{ ...original, operation: { ...original.operation, remote } },
			'retry',
		).command,
	).toMatchObject({ baseVersion: 1 });
	expect(() =>
		retryReviewedOperation(
			{
				...original,
				operation: {
					...original.operation,
					remote: { ...remote, setup: null },
				},
			},
			'retry',
		),
	).toThrow('no longer exists');
	const command = {
		type: 'setup.select-current' as const,
		carId: 'car',
		setupId: 'setup',
		baseCurrent: { setupId: null, version: 0 },
	};
	expect(
		retryReviewedOperation(
			{ ...original, operation: { ...original.operation, command, remote } },
			'retry',
		).command,
	).toMatchObject({ baseCurrent: { setupId: 'setup', version: 7 } });
});
it('keeps missing mutable records absent and leaves non-timezone settings commands unchanged', () => {
	for (const review of syncReviewFixtures) {
		if (review.family === 'build')
			expect(
				retryReviewedOperation(
					{
						...review,
						operation: {
							...review.operation,
							remote: { carId: 'car', version: 5, components: [] },
						},
					},
					'retry',
				).command,
			).toMatchObject({ base: null });
		if (review.family === 'drive')
			expect(
				retryReviewedOperation(
					{
						...review,
						operation: {
							...review.operation,
							remote: { carId: 'car', version: 5, sessions: [] },
						},
					},
					'retry',
				).command,
			).toMatchObject({ base: null });
		if (review.family === 'maintenance')
			expect(
				retryReviewedOperation(
					{
						...review,
						operation: {
							...review.operation,
							remote: { carId: 'car', version: 5, plans: [], records: [] },
						},
					},
					'retry',
				).command,
			).toMatchObject({ base: null });
		if (review.family === 'settings') {
			const command = { type: 'invite-create' as const, code: 'DEVICE' };
			expect(
				retryReviewedOperation(
					{ ...review, operation: { ...review.operation, command } },
					'retry',
				).command,
			).toEqual(command);
		}
	}
});

it('keeps replacement identity separate from the reviewed Component it replaces', () => {
	const review = syncReviewFixtures[2];
	if (review.family !== 'build') throw new Error('Fixture mismatch');
	const previous = {
		id: 'previous',
		carId: 'car',
		slot: 'motor',
		name: 'Saved motor',
	};
	const command = {
		...review.operation.command,
		action: 'replace' as const,
		componentId: 'replacement',
		base: previous,
	};
	const revised = {
		...review,
		operation: {
			...review.operation,
			command,
			remote: { carId: 'car', version: 5, components: [previous] },
		},
	};
	expect(retryReviewedOperation(revised, 'retry').command).toMatchObject({
		componentId: 'replacement',
		base: previous,
	});
});
