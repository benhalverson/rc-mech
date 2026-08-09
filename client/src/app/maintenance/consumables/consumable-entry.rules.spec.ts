import { describe, expect, it } from 'vitest';
import type { ConsumableEntry } from '../maintenance.models';
import {
	type ConsumableEntryForm,
	emptyConsumableEntryForm,
	existingConsumableEntryForm,
	hasConsumableTireSnapshot,
	mapConsumableSaveCommand,
	newConsumableEntryForm,
	parseConsumableCost,
} from './consumable-entry.rules';

const baseForm = (): ConsumableEntryForm => ({
	...emptyConsumableEntryForm(),
	carId: 'car-1',
	performedAt: '2026-08-09T12:30',
});

describe('consumable entry rules', () => {
	it('creates empty and new forms in the selected timezone', () => {
		expect(emptyConsumableEntryForm()).toEqual({
			carId: '',
			kind: 'shock-fluid',
			performedAt: '',
			fluidArea: 'front-shocks',
			customArea: '',
			axle: 'front',
			frontDetails: '',
			rearDetails: '',
			frontCost: '',
			rearCost: '',
			notes: '',
		});
		expect(
			newConsumableEntryForm(
				'car-1',
				'UTC',
				new Date('2026-08-09T12:30:00.000Z'),
			),
		).toMatchObject({ carId: 'car-1', performedAt: '2026-08-09T12:30' });
	});

	it('normalizes existing fluid and tire entries into editor forms', () => {
		const fluid: ConsumableEntry = {
			id: 'fluid-1',
			carId: 'car-1',
			kind: 'shock-fluid',
			performedAt: '2026-08-09T12:30:00.000Z',
			fluidArea: 'custom',
			customArea: 'Center diff',
			cost: 12.5,
			notes: 'Changed',
		};
		expect(existingConsumableEntryForm(fluid, 'UTC')).toMatchObject({
			fluidArea: 'custom',
			customArea: 'Center diff',
			frontCost: '12.5',
			notes: 'Changed',
		});
		expect(
			existingConsumableEntryForm(
				{
					...fluid,
					kind: 'differential-fluid',
					fluidArea: null,
					customArea: null,
					cost: null,
					notes: null,
				},
				'UTC',
			),
		).toMatchObject({
			fluidArea: 'front-shocks',
			customArea: '',
			frontCost: '',
			notes: '',
		});
		expect(
			existingConsumableEntryForm(
				{
					...fluid,
					kind: 'tires',
					axle: null,
					frontDetails: null,
					rearDetails: null,
					frontCost: null,
					rearCost: 18,
				},
				'UTC',
			),
		).toMatchObject({
			axle: 'front',
			frontDetails: '',
			rearDetails: '',
			frontCost: '',
			rearCost: '18',
		});
		expect(
			existingConsumableEntryForm(
				{ ...fluid, kind: 'tires', frontCost: 24, rearCost: null },
				'UTC',
			),
		).toMatchObject({ frontCost: '24', rearCost: '' });
	});

	it('parses optional costs and recognizes either tire snapshot value', () => {
		expect(parseConsumableCost('')).toBeNull();
		expect(parseConsumableCost('  ')).toBeNull();
		expect(parseConsumableCost('0')).toBe(0);
		expect(parseConsumableCost('12.5')).toBe(12.5);
		expect(parseConsumableCost('-1')).toBe('invalid');
		expect(parseConsumableCost('not-a-number')).toBe('invalid');
		expect(hasConsumableTireSnapshot(' Cut pin ', '')).toBe(true);
		expect(hasConsumableTireSnapshot('', ' 12 ')).toBe(true);
		expect(hasConsumableTireSnapshot(' ', ' ')).toBe(false);
	});

	it('rejects missing tire snapshots and invalid costs', () => {
		expect(
			mapConsumableSaveCommand(
				{ ...baseForm(), kind: 'tires', axle: 'front' },
				'UTC',
				'create',
				null,
			),
		).toEqual({
			ok: false,
			message: 'Add front or rear tire details before saving.',
		});
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					kind: 'tires',
					axle: 'rear',
					frontDetails: 'Ignored',
				},
				'UTC',
				'create',
				null,
			),
		).toEqual({
			ok: false,
			message: 'Add front or rear tire details before saving.',
		});
		for (const form of [
			{ ...baseForm(), frontCost: '-1' },
			{ ...baseForm(), rearCost: 'invalid' },
		])
			expect(mapConsumableSaveCommand(form, 'UTC', 'create', null)).toEqual({
				ok: false,
				message: 'Costs must be zero or greater.',
			});
	});

	it('maps a complete both-axle snapshot into one immutable save command', () => {
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					kind: 'tires',
					axle: 'both',
					frontDetails: ' Front ',
					frontCost: '30.5',
					rearDetails: ' Rear ',
					rearCost: '0',
					notes: ' Track day ',
				},
				'UTC',
				'edit',
				'entry-1',
			),
		).toEqual({
			ok: true,
			command: {
				kind: 'save',
				mode: 'edit',
				carId: 'car-1',
				id: 'entry-1',
				maintenance: {
					kind: 'tires',
					performedAt: '2026-08-09T12:30:00.000Z',
					axle: 'both',
					frontDetails: 'Front',
					frontCost: 30.5,
					rearDetails: 'Rear',
					rearCost: 0,
					notes: 'Track day',
				},
			},
		});
	});

	it('omits empty and axle-inapplicable tire fields', () => {
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					kind: 'tires',
					axle: 'front',
					frontCost: '10',
					rearDetails: 'Ignore',
					rearCost: '20',
				},
				'UTC',
				'create',
				null,
			),
		).toMatchObject({
			ok: true,
			command: {
				maintenance: {
					kind: 'tires',
					performedAt: '2026-08-09T12:30:00.000Z',
					axle: 'front',
					frontCost: 10,
				},
			},
		});
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					kind: 'tires',
					axle: 'rear',
					frontDetails: 'Ignore',
					frontCost: '10',
					rearDetails: 'Rear only',
				},
				'UTC',
				'create',
				null,
			),
		).toMatchObject({
			ok: true,
			command: {
				maintenance: {
					kind: 'tires',
					performedAt: '2026-08-09T12:30:00.000Z',
					axle: 'rear',
					rearDetails: 'Rear only',
				},
			},
		});
	});

	it('maps custom and ordinary fluid entries without empty optionals', () => {
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					fluidArea: 'custom',
					customArea: ' Center diff ',
					frontCost: '12.5',
					notes: ' Changed ',
				},
				'UTC',
				'create',
				null,
			),
		).toMatchObject({
			ok: true,
			command: {
				maintenance: {
					kind: 'shock-fluid',
					fluidArea: 'custom',
					customArea: 'Center diff',
					cost: 12.5,
					notes: 'Changed',
				},
			},
		});
		expect(
			mapConsumableSaveCommand(
				{
					...baseForm(),
					kind: 'differential-fluid',
					fluidArea: 'rear-differential',
					customArea: 'Ignore',
				},
				'UTC',
				'create',
				null,
			),
		).toMatchObject({
			ok: true,
			command: {
				maintenance: {
					kind: 'differential-fluid',
					performedAt: '2026-08-09T12:30:00.000Z',
					fluidArea: 'rear-differential',
				},
			},
		});
	});
});
