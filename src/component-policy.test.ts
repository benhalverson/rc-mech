import test from 'node:test';
import assert from 'node:assert/strict';
import {
	STANDARD_COMPONENT_SLOTS,
	canEditComponent,
	componentSlotType,
	normalizeComponentSlot,
	ownsComponent,
} from './component-policy.ts';

test('standard component slots classify common RC components', () => {
	assert.ok(STANDARD_COMPONENT_SLOTS.includes('motor'));
	assert.equal(componentSlotType('motor'), 'standard');
	assert.equal(componentSlotType('steering servo'), 'standard');
	assert.equal(normalizeComponentSlot(' Steering Servo '), 'steering-servo');
});

test('custom component slots remain supported', () => {
	assert.equal(componentSlotType('front sway bar'), 'custom');
	assert.equal(componentSlotType('front sway bar', 'custom'), 'custom');
	assert.equal(componentSlotType('motor', 'custom'), 'invalid');
});

test('component ownership and lifecycle checks fail closed', () => {
	assert.equal(ownsComponent('car-1', 'car-1'), true);
	assert.equal(ownsComponent('car-1', 'car-2'), false);
	assert.equal(canEditComponent(null), true);
	assert.equal(canEditComponent('2026-01-01T00:00:00.000Z'), false);
});
