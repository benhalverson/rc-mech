import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultTimezone, isValidTimezone } from './settings.models';

describe('settings model helpers', () => {
	const browserIntl = Intl;

	afterEach(() => {
		vi.restoreAllMocks();
		vi.stubGlobal('Intl', browserIntl);
	});

	it('uses the browser timezone and falls back when it is empty', () => {
		expect(defaultTimezone()).toBeTruthy();
		const browserOptions = Intl.DateTimeFormat().resolvedOptions();
		vi.spyOn(Intl.DateTimeFormat.prototype, 'resolvedOptions').mockReturnValue({
			...browserOptions,
			timeZone: '',
		});
		expect(defaultTimezone()).toBe('UTC');
	});

	it('falls back when browser timezone discovery fails', () => {
		vi.stubGlobal('Intl', {
			DateTimeFormat: class {
				constructor() {
					throw new Error('Intl unavailable');
				}
			},
		});
		expect(defaultTimezone()).toBe('UTC');
	});

	it('validates UTC, regional, unsupported, and malformed timezones', () => {
		expect(isValidTimezone('UTC')).toBe(true);
		expect(isValidTimezone('America/Los_Angeles')).toBe(true);
		expect(isValidTimezone('GMT')).toBe(false);
		expect(isValidTimezone('Definitely/Not_A_Timezone')).toBe(false);
	});
});
