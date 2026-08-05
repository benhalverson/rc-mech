import assert from 'node:assert/strict';
import test from 'node:test';
import {
	canWriteSetup,
	copySetupSnapshot,
	hasSourceMetadata,
	ownsSetup,
	shouldSelectCurrentSetup,
} from './setup-policy.ts';
import { setupInput } from './types.ts';

test('setup ownership and archived-car policy fail closed', () => {
	assert.equal(ownsSetup({ carId: 'car-1' }, 'car-1'), true);
	assert.equal(ownsSetup({ carId: 'car-2' }, 'car-1'), false);
	assert.equal(ownsSetup(undefined, 'car-1'), false);
	assert.equal(canWriteSetup({ archivedAt: null }), true);
	assert.equal(
		canWriteSetup({ archivedAt: '2026-08-05T00:00:00.000Z' }),
		false,
	);
});

test('copy creates an independent snapshot and preserves lineage data separately', () => {
	const source = { track: 'Club', vehicle: { rideHeight: 24 } };
	const copy = copySetupSnapshot(source, { track: 'Outdoor' });
	(copy.vehicle as { rideHeight: number }).rideHeight = 26;
	assert.equal(source.track, 'Club');
	assert.equal((source.vehicle as { rideHeight: number }).rideHeight, 24);
	assert.equal(copy.track, 'Outdoor');
});

test('current selection and source metadata are explicit contracts', () => {
	assert.equal(shouldSelectCurrentSetup(true), true);
	assert.equal(shouldSelectCurrentSetup(), false);
	assert.equal(
		hasSourceMetadata({ sourceUrl: 'https://example.test/setup' }),
		true,
	);
	assert.equal(hasSourceMetadata({}), false);
	assert.equal(
		setupInput.safeParse({
			name: 'Imported baseline',
			sourceUrl: 'https://example.test/setup',
			rawValues: { caster: 'not mapped' },
		}).success,
		true,
	);
	assert.equal(
		setupInput.safeParse({ name: 'Clearable', track: null }).success,
		true,
	);
	assert.equal(
		setupInput.safeParse({ name: 'Invalid', status: null }).success,
		false,
	);
});
