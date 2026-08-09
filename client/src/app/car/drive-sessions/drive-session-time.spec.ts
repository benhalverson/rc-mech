import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	browserTimezone,
	localDateTime,
	resolveTimezone,
	safeTimezone,
	toIso,
} from './drive-session-time';

describe('drive session time rules', () => {
	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
	});

	it('normalizes supported and invalid timezones', () => {
		expect(safeTimezone('UTC')).toBe('UTC');
		expect(safeTimezone('America/Los_Angeles')).toBe('America/Los_Angeles');
		expect(safeTimezone('')).toBe('UTC');
		expect(safeTimezone(null)).toBe('UTC');
		expect(safeTimezone('Not/A-Timezone')).toBe('UTC');
		expect(resolveTimezone('Not/A-Timezone', 'America/Los_Angeles')).toBe(
			'America/Los_Angeles',
		);
		expect(resolveTimezone(null, undefined)).toBeTruthy();
	});

	it('discovers the browser timezone with deterministic fallbacks', () => {
		expect(browserTimezone()).toBeTruthy();
		const realDateTimeFormat = Intl.DateTimeFormat;
		vi.spyOn(Intl, 'DateTimeFormat').mockImplementation((locales, options) => {
			if (options === undefined)
				return {
					resolvedOptions: () => ({ timeZone: '' }),
				} as Intl.DateTimeFormat;
			return new realDateTimeFormat(locales, options);
		});
		expect(browserTimezone()).toBe('UTC');
		vi.restoreAllMocks();
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				constructor() {
					throw new Error('Intl unavailable');
				}
			},
		});
		expect(browserTimezone()).toBe('UTC');
	});

	it('converts between local editor values and canonical instants', () => {
		expect(
			localDateTime('2026-08-08T01:30:00.000Z', 'America/Los_Angeles'),
		).toBe('2026-08-07T18:30');
		expect(toIso('2026-08-07T18:30', 'America/Los_Angeles')).toBe(
			'2026-08-08T01:30:00.000Z',
		);
		expect(toIso('', 'UTC')).toBe('');
		expect(toIso('2026-08-08', 'UTC')).toBe('');

		vi.spyOn(Intl.DateTimeFormat.prototype, 'formatToParts').mockReturnValue([
			{ type: 'year', value: '2026' },
			{ type: 'month', value: '08' },
			{ type: 'day', value: '07' },
			{ type: 'hour', value: '18' },
		]);
		expect(localDateTime('2026-08-08T01:30:00.000Z', 'UTC')).toBe(
			'2026-08-07T18:',
		);
	});
});
