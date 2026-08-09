import { describe, expect, it } from 'vitest';
import { parseSignOutResponse } from './sign-out-response';

describe('parseSignOutResponse', () => {
	it('returns the schema-derived response contract', () => {
		expect(parseSignOutResponse({ success: true })).toEqual({ success: true });
	});

	it('rejects values outside the response contract', () => {
		expect(() => parseSignOutResponse(null)).toThrow();
		expect(() => parseSignOutResponse({ success: false })).toThrow();
	});
});
