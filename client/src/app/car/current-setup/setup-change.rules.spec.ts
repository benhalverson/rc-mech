import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CurrentSetupSnapshot } from './current-setup.models';
import {
	browserTimezone,
	resolveSetupTimezone,
	setupChangeDraftFromForm,
	setupChangeFormFromSnapshot,
	setupChangeName,
	setupChangeRemainingGroups,
	setupDateAt,
	validTimezone,
} from './setup-change.rules';

const setup = (
	overrides: Partial<CurrentSetupSnapshot> = {},
): CurrentSetupSnapshot => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay baseline',
	current: true,
	context: {
		recordedAt: '2026-08-01T00:00:00.000Z',
		track: 'Club track',
		event: null,
		surface: 'Clay',
		traction: 'High',
		moisture: null,
		condition: 'Dry',
		temperature: '72 F',
	},
	sections: {
		vehicle: { chassisRideHeight: 12, weight: '1,510 g' },
		drivetrain: {
			configuration: '2WD',
			diffOil: '7k',
			diffHeight: '3 mm',
			motor: '13.5T',
		},
		electronics: { esc: 'Stock', customMap: { boost: 0 } },
		tires: {},
		shocks: { frontShockOil: '35 wt', rearOil: '450 cSt' },
		frontSuspension: { frontCamber: '-1°', frontToe: '1 mm out' },
		rearSuspension: {
			rearCamber: '-2°',
			rearCBlockPill: 'up/in',
			dBlockPillPosition: 'center/in',
			toe: 'legacy scalar',
		},
		notes: { setupNotes: 'Main-day setup' },
	},
	copiedFromSetupId: null,
	...overrides,
});

describe('setup change rules', () => {
	afterEach(() => vi.restoreAllMocks());

	it('builds a garage-local unique name and calendar date', () => {
		const now = new Date('2026-08-09T21:14:00.000Z');
		expect(validTimezone('America/Los_Angeles')).toBe(true);
		expect(validTimezone('Not/A-Timezone')).toBe(false);
		expect(resolveSetupTimezone('UTC')).toBe('UTC');
		expect(resolveSetupTimezone('Not/A-Timezone')).toBe(browserTimezone());
		expect(resolveSetupTimezone(null)).toBe(browserTimezone());
		expect(setupChangeName('Clay baseline', now, 'America/Los_Angeles')).toBe(
			'Clay baseline · Aug 9, 2:14 PM',
		);
		expect(setupChangeName('x'.repeat(160), now, 'UTC')).toHaveLength(160);
		expect(setupChangeName('Clay baseline', now, 'invalid')).toBe(
			'Clay baseline · Aug 9, 9:14 PM',
		);
		expect(setupDateAt(now, 'America/Los_Angeles')).toBe('2026-08-09');
		expect(setupDateAt(now, 'invalid')).toBe('2026-08-09');
	});

	it('falls back to UTC when browser timezone discovery throws', () => {
		vi.spyOn(Intl, 'DateTimeFormat').mockImplementationOnce(() => {
			throw new Error('timezone unavailable');
		});
		expect(browserTimezone()).toBe('UTC');
	});

	it('falls back to UTC when browser timezone discovery is empty', () => {
		vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
			locale: 'en-US',
			calendar: 'gregory',
			numberingSystem: 'latn',
			timeZone: '',
		});
		expect(browserTimezone()).toBe('UTC');
	});

	it('handles an unavailable formatted calendar part', () => {
		vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue(
			[],
		);
		expect(setupDateAt(new Date('2026-08-09T12:00:00.000Z'), 'UTC')).toBe('--');
	});

	it('prefills every setup value while normalizing recognized aliases', () => {
		const source = setup();
		const form = setupChangeFormFromSnapshot(
			source,
			new Date('2026-08-09T21:14:00.000Z'),
			'America/Los_Angeles',
		);
		expect(form).toMatchObject({
			name: 'Clay baseline · Aug 9, 2:14 PM',
			recordedAt: '2026-08-09',
			track: 'Club track',
			event: '',
			moisture: '',
			sections: {
				vehicle: { rideHeight: '12', weight: '1,510 g', wheelbase: '' },
				drivetrain: {
					driveType: '2WD',
					gearDiffOil: '7k',
					gearDiffHeight: '3 mm',
					motor: '13.5T',
				},
				shocks: { frontOil: '35 wt', rearOil: '450 cSt' },
				frontSuspension: { camber: '-1°', toe: '1 mm out' },
				rearSuspension: {
					camber: '-2°',
					cBlockPill: 'up/in',
					dBlockPill: 'center/in',
				},
			},
		});
		expect(form.sections.rearSuspension['toe']).toBeUndefined();
		expect(form.sections.electronics['customMap']).toBe('{"boost":0}');
		const emptyContext = setupChangeFormFromSnapshot(
			setup({ context: {} }),
			new Date('2026-08-09T21:14:00.000Z'),
			'UTC',
		);
		expect(emptyContext).toMatchObject({
			track: '',
			event: '',
			surface: '',
			traction: '',
			moisture: '',
			condition: '',
			temperature: '',
		});

		const groups = setupChangeRemainingGroups(source);
		expect(groups.flatMap(({ fields }) => fields.map(({ id }) => id))).toEqual(
			expect.arrayContaining([
				'vehicle.weight',
				'electronics.customMap',
				'notes.setupNotes',
			]),
		);
		expect(
			groups.flatMap(({ fields }) => fields.map(({ id }) => id)),
		).not.toEqual(
			expect.arrayContaining([
				'vehicle.chassisRideHeight',
				'rearSuspension.toe',
			]),
		);
	});

	it('preserves unchanged value types and writes all edits into one draft', () => {
		const source = setup();
		const form = setupChangeFormFromSnapshot(
			source,
			new Date('2026-08-09T21:14:00.000Z'),
			'UTC',
		);
		form.name = 'Finals setup';
		form.recordedAt = '2026-08-10';
		form.track = '  Finals track  ';
		form.event = '';
		form.sections.vehicle['rideHeight'] = '14 mm';
		form.sections.vehicle['weight'] = '1,510 g';
		form.sections.drivetrain['driveType'] = '4WD';
		form.sections.electronics['esc'] = '';
		form.sections.tires['front'] = 'Pin tire';
		form.sections.notes['setupNotes'] = '  Finals notes  ';

		const draft = setupChangeDraftFromForm(source, form);
		expect(draft).toMatchObject({
			name: 'Finals setup',
			recordedAt: '2026-08-10T00:00:00.000Z',
			track: 'Finals track',
			event: null,
			sections: {
				vehicle: { rideHeight: '14 mm', weight: '1,510 g' },
				drivetrain: { driveType: '4WD', motor: '13.5T' },
				electronics: { customMap: { boost: 0 } },
				tires: { front: 'Pin tire' },
				rearSuspension: { toe: 'legacy scalar' },
				notes: { setupNotes: 'Finals notes' },
			},
		});
		expect(draft.sections.vehicle['chassisRideHeight']).toBeUndefined();
		expect(draft.sections.drivetrain['configuration']).toBeUndefined();
		expect(draft.sections.drivetrain['diffOil']).toBe('7k');
	});

	it('keeps untouched aliases and supports clearing the copied date', () => {
		const source = setup({
			sections: {
				...setup().sections,
				vehicle: { chassisRideHeight: 12 },
				tires: { rear: null },
			},
		});
		const form = setupChangeFormFromSnapshot(
			source,
			new Date('2026-08-09T12:00:00.000Z'),
			'UTC',
		);
		form.recordedAt = '';
		const draft = setupChangeDraftFromForm(source, form);
		expect(draft.recordedAt).toBeNull();
		expect(draft.sections.vehicle['chassisRideHeight']).toBe(12);
		expect(draft.sections.vehicle['rideHeight']).toBeUndefined();
		expect(draft.sections.tires['rear']).toBeNull();
	});
});
