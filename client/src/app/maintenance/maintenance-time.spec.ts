import { afterEach, describe, expect, it, vi } from 'vitest';
import { localDateTime, localDateTimeToIso } from './maintenance-time';

describe('maintenance time', () => {
	afterEach(() => vi.unstubAllGlobals());

	it('converts local date-time values with a named timezone', () => {
		expect(
			localDateTime(
				new Date('2026-08-09T19:30:00.000Z'),
				'America/Los_Angeles',
			),
		).toBe('2026-08-09T12:30');
		expect(localDateTimeToIso('2026-08-09T12:30', 'America/Los_Angeles')).toBe(
			'2026-08-09T19:30:00.000Z',
		);
		expect(localDateTimeToIso('invalid', 'UTC')).toBe('');
		expect(localDateTimeToIso('2026-08-09T', 'UTC')).toBe('');
	});

	it('keeps missing internationalized parts deterministic', () => {
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				formatToParts(): Intl.DateTimeFormatPart[] {
					return [];
				}
			},
		});
		expect(localDateTime(new Date('2026-08-09T19:30:00.000Z'), 'UTC')).toBe(
			'--T:',
		);
	});
});
