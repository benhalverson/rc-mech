import { describe, expect, it } from 'vitest';
import type { CurrentSetupSnapshot } from './current-setup.models';
import {
	changesFromPreviousSetup,
	currentSetupPriorityRows,
	currentSetupRemainingRows,
	displaySetupValue,
	setupFieldLabel,
} from './current-setup.rules';

const setup = (
	overrides: Partial<CurrentSetupSnapshot> = {},
): CurrentSetupSnapshot => ({
	id: 'setup-current',
	carId: 'car-1',
	name: 'Clay baseline',
	current: true,
	context: {
		recordedAt: '2026-08-09T00:00:00.000Z',
		track: 'Club track',
		event: null,
		surface: 'Clay',
		traction: 'High',
		moisture: null,
		condition: 'Grooved',
		temperature: '72 F',
	},
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	copiedFromSetupId: null,
	...overrides,
});

describe('current setup readout rules', () => {
	it('formats recorded values without unit conversion and labels flexible keys', () => {
		expect(displaySetupValue(null)).toBe('Not recorded');
		expect(displaySetupValue(undefined)).toBe('Not recorded');
		expect(displaySetupValue('')).toBe('Not recorded');
		expect(displaySetupValue('35 wt')).toBe('35 wt');
		expect(displaySetupValue(12)).toBe('12');
		expect(displaySetupValue(true)).toBe('true');
		expect(displaySetupValue(12n)).toBe('12');
		expect(displaySetupValue({ position: 'up/in' })).toBe(
			'{"position":"up/in"}',
		);
		expect(displaySetupValue(Symbol('pill'))).toBe('Symbol(pill)');
		const circular: { self?: unknown } = {};
		circular.self = circular;
		expect(displaySetupValue(circular)).toBe('[object Object]');
		expect(setupFieldLabel('frontRideHeight')).toBe('Front Ride Height');
		expect(setupFieldLabel('front_diff-oil')).toBe('Front diff oil');
	});

	it('orders a complete 4WD priority readout and keeps every remaining value', () => {
		const value = setup({
			sections: {
				vehicle: {
					rideHeight: '12 mm',
					weight: '1,510 g',
					wheelbase: '285 mm',
				},
				drivetrain: {
					driveType: '4WD',
					frontDiffOil: '7k',
					centerDiffOil: '10k',
					rearDiffOil: '5k',
				},
				electronics: { esc: 'Stock profile' },
				tires: {},
				shocks: {
					frontSpring: 'Blue',
					frontOil: '35 wt',
					rearSpring: 'Green',
					rearOil: '450 cSt',
				},
				frontSuspension: { camber: '-1°', toe: '1 mm out' },
				rearSuspension: {
					camber: '-2°',
					cBlockPill: 'up/in',
					dBlockPill: 'center/in',
					toe: 'legacy scalar retained',
				},
				notes: { setupNotes: 'Long main day setup' },
			},
		});
		const priority = currentSetupPriorityRows(value);
		expect(priority.map(({ label }) => label)).toEqual([
			'Ride height',
			'Camber · Front / Rear',
			'Front toe',
			'Rear toe · C / D Pill',
			'Front shock spring',
			'Front shock oil',
			'Rear shock spring',
			'Rear shock oil',
			'Drivetrain configuration',
			'Front differential oil',
			'Center differential oil',
			'Rear differential oil',
		]);
		expect(priority[0]?.value).toBe('12 mm');
		expect(priority[1]?.value).toBe('-1° / -2°');
		expect(priority[1]?.segments).toEqual([
			{
				label: 'Front camber',
				value: '-1°',
				focusField: 'frontSuspension.camber',
			},
			{
				label: 'Rear camber',
				value: '-2°',
				focusField: 'rearSuspension.camber',
			},
		]);
		expect(priority[3]?.value).toBe('up/in / center/in');
		expect(priority[3]?.segments?.[1]).toEqual({
			label: 'D block Pill',
			value: 'center/in',
			focusField: 'rearSuspension.dBlockPill',
		});
		expect(priority[5]?.value).toBe('35 wt');
		expect(priority[7]?.value).toBe('450 cSt');
		expect(priority[10]?.value).toBe('10k');

		const remaining = currentSetupRemainingRows(value);
		expect(remaining.map(({ label }) => label)).toEqual([
			'Vehicle · Weight',
			'Vehicle · Wheelbase',
			'Electronics · Esc',
			'Rear suspension · Toe',
			'Notes · Setup Notes',
		]);
		expect(remaining.at(-1)?.value).toBe('Long main day setup');
		expect(
			remaining.find(({ id }) => id === 'rearSuspension.toe')?.focusField,
		).toBe('rearSuspension.cBlockPill');
	});

	it('uses setup-recorded 2WD and decoupled-center configurations only', () => {
		const twoWheel = setup({
			sections: {
				...setup().sections,
				drivetrain: {
					configuration: '2WD',
					gearDifferentialOil: '7k',
					gearDifferentialHeight: '3 mm',
				},
			},
		});
		expect(
			currentSetupPriorityRows(twoWheel)
				.slice(-3)
				.map(({ label, value }) => ({
					label,
					value,
				})),
		).toEqual([
			{ label: 'Drivetrain configuration', value: '2WD' },
			{ label: 'Gear differential oil', value: '7k' },
			{ label: 'Gear differential height', value: '3 mm' },
		]);

		const decoupled = setup({
			sections: {
				...setup().sections,
				drivetrain: {
					layout: 'four-wheel drive',
					frontDifferentialOil: '7k',
					centerDrive: 'Decoupled center slipper',
					rearDifferentialOil: '5k',
					centerDifferentialOil: 'retained source value',
				},
			},
		});
		const drivetrain = currentSetupPriorityRows(decoupled).slice(6);
		expect(drivetrain).toContainEqual({
			id: 'center-drive',
			label: 'Center drive',
			value: 'Decoupled center slipper',
			focusField: 'drivetrain.centerSlipper',
		});
		expect(drivetrain.map(({ label }) => label)).not.toContain(
			'Center differential oil',
		);
		expect(
			currentSetupRemainingRows(decoupled).map(({ value }) => value),
		).toContain('retained source value');

		const terseSlipper = setup({
			sections: {
				...setup().sections,
				drivetrain: {
					driveType: '4WD',
					centerSlipper: 'Decoupled',
				},
			},
		});
		expect(currentSetupPriorityRows(terseSlipper)).toContainEqual({
			id: 'center-drive',
			label: 'Center drive',
			value: 'Decoupled',
			focusField: 'drivetrain.centerSlipper',
		});
	});

	it('keeps missing priorities fixed and displays recorded drivetrain aliases', () => {
		const generic = setup({
			sections: {
				...setup().sections,
				drivetrain: {
					diffOil: '8k',
					diffHeight: 'low',
					frontDifferentialOil: '6k',
					centerDifferentialOil: '9k',
					rearDifferentialOil: '4k',
					centerSlipper: 'Coupled slipper',
				},
			},
		});
		const rows = currentSetupPriorityRows(generic);
		expect(rows[0]?.value).toBe('Not recorded');
		expect(rows[1]?.value).toBe('Not recorded');
		expect(rows[2]?.value).toBe('Not recorded');
		expect(rows[3]?.value).toBe('Not recorded');
		expect(rows[4]?.value).toBe('Not recorded');
		expect(rows).toContainEqual({
			id: 'gear-differential-oil',
			label: 'Gear differential oil',
			value: '8k',
			focusField: 'drivetrain.gearDiffOil',
		});
		expect(rows).toContainEqual({
			id: 'center-drive',
			label: 'Center drive',
			value: 'Coupled slipper',
			focusField: 'drivetrain.centerSlipper',
		});
		expect(currentSetupPriorityRows(setup()).at(-1)?.value).toBe(
			'Not recorded',
		);
		const partial = currentSetupPriorityRows(
			setup({
				sections: {
					...setup().sections,
					rearSuspension: {
						camber: '-2°',
						dBlockPill: 'down/out',
					},
				},
			}),
		);
		expect(partial[1]?.value).toBe('Not recorded / -2°');
		expect(partial[3]?.value).toBe('Not recorded / down/out');
	});

	it('shows only changed fields from the copied source in old-to-new form', () => {
		const previous = setup({
			id: 'setup-previous',
			current: false,
			context: { ...setup().context, track: 'Old track', event: undefined },
			sections: {
				...setup().sections,
				vehicle: { rideHeight: '12 mm', weight: '1500 g' },
				frontSuspension: { camber: '-1°' },
			},
		});
		const current = setup({
			copiedFromSetupId: previous.id,
			context: { ...setup().context, track: 'New track', event: 'Final' },
			sections: {
				...setup().sections,
				vehicle: { rideHeight: '14 mm', weight: '1500 g' },
				rearSuspension: { camber: '-2°' },
			},
		});
		const changes = changesFromPreviousSetup(current, [current, previous]);
		expect(changes).toEqual(
			expect.arrayContaining([
				{
					id: 'vehicle.rideHeight',
					label: 'Vehicle · Ride Height',
					previousValue: '12 mm',
					currentValue: '14 mm',
				},
				{
					id: 'frontSuspension.camber',
					label: 'Front suspension · Camber',
					previousValue: '-1°',
					currentValue: 'Not recorded',
				},
				{
					id: 'rearSuspension.camber',
					label: 'Rear suspension · Camber',
					previousValue: 'Not recorded',
					currentValue: '-2°',
				},
			]),
		);
		expect(changes.some(({ label }) => label === 'Vehicle · Weight')).toBe(
			false,
		);
		expect(changes.some(({ label }) => label === 'Track')).toBe(true);
		expect(changes.some(({ label }) => label === 'Event')).toBe(true);
		expect(changesFromPreviousSetup(setup(), [previous])).toEqual([]);
		expect(
			changesFromPreviousSetup(setup({ copiedFromSetupId: 'missing' }), [
				previous,
			]),
		).toEqual([]);
	});
});
