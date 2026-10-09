import { expect, it } from 'vitest';
import type { SyncReview } from './offline-sync-review.models';
import { syncReviewFixtures } from './offline-sync-review.testing';
import {
	deviceReviewValue,
	remoteReviewValue,
	reviewFeedback,
	reviewFields,
} from './offline-sync-review-presenter';

it('renders readable values without transport identities or version internals', () => {
	expect(
		reviewFields(
			{
				name: 'Buggy',
				version: 99,
				componentId: 'motor',
				planId: null,
				setupId: 'unknown',
				nested: { notes: null, ready: true },
				absent: undefined,
			},
			{ motor: 'Stock motor' },
		),
	).toEqual([
		{ label: 'Name', value: 'Buggy' },
		{ label: 'Component', value: 'Stock motor' },
		{ label: 'Plan', value: 'None' },
		{ label: 'Setup', value: 'Unavailable record' },
		{ label: 'Nested / Notes', value: 'Not available' },
		{ label: 'Nested / Ready', value: 'true' },
		{ label: 'Absent', value: 'Not available' },
	]);
	expect(reviewFields(null, {})).toEqual([
		{ label: 'Record', value: 'Not available' },
	]);
	expect(reviewFields('UTC', {})).toEqual([{ label: 'Value', value: 'UTC' }]);
	for (const review of syncReviewFixtures) {
		expect(deviceReviewValue(review)).toBeDefined();
		expect(remoteReviewValue(review)).toBeDefined();
		expect(reviewFeedback(review)).toBeTruthy();
		const absent = {
			...review,
			operation: {
				...review.operation,
				remote: undefined,
				feedback: undefined,
			},
		} as SyncReview;
		expect(remoteReviewValue(absent)).toBeUndefined();
		expect(reviewFeedback(absent)).toContain('Review the device');
	}
	const car = syncReviewFixtures[0];
	if (car.family !== 'car') throw new Error('Fixture mismatch');
	expect(
		deviceReviewValue({
			...car,
			operation: {
				...car.operation,
				command: { type: 'car.create', carId: 'car', car: { name: 'New' } },
			},
		}),
	).toEqual({ name: 'New' });
	const setup = syncReviewFixtures[1];
	if (setup.family !== 'setup') throw new Error('Fixture mismatch');
	expect(
		deviceReviewValue({
			...setup,
			operation: {
				...setup.operation,
				command: {
					type: 'setup.create',
					carId: 'car',
					setupId: 'setup',
					setup: { name: 'New' },
					makeCurrent: false,
					baseCurrent: null,
					copiedFromSetupId: null,
				},
			},
		}),
	).toEqual({ name: 'New' });
});

it('describes archive intent and the previous Component in a replacement review', () => {
	const car = syncReviewFixtures[0];
	if (car.family !== 'car') throw new Error('Fixture mismatch');
	for (const type of ['car.archive', 'car.restore'] as const)
		expect(
			deviceReviewValue({
				...car,
				operation: {
					...car.operation,
					command: {
						type,
						carId: 'car',
						baseVersion: 1,
						base: { archivedAt: null },
					},
				},
			}),
		).toEqual({ status: type === 'car.archive' ? 'Archived' : 'Active' });
	const review = syncReviewFixtures[2];
	if (review.family !== 'build') throw new Error('Fixture mismatch');
	const previous = {
		id: 'previous',
		carId: 'car',
		slot: 'motor',
		name: 'Saved motor',
	};
	expect(
		remoteReviewValue({
			...review,
			operation: {
				...review.operation,
				command: { ...review.operation.command, base: previous },
				remote: { carId: 'car', version: 5, components: [previous] },
			},
		}),
	).toEqual(previous);
});
