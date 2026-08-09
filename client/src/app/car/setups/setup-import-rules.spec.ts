import { describe, expect, it } from 'vitest';
import { isSupportedSoDialedUrl } from './setup-import-rules';

describe('So Dialed import rules', () => {
	it('accepts only owner-safe setup URLs', () => {
		expect(isSupportedSoDialedUrl(' https://sodialed.com/setup/Abc123/ ')).toBe(
			true,
		);
		expect(
			isSupportedSoDialedUrl('https://www.sodialed.com:443/setup/abc'),
		).toBe(true);
		for (const url of [
			'not a url',
			'http://sodialed.com/setup/abc',
			'https://example.com/setup/abc',
			'https://user@sodialed.com/setup/abc',
			'https://user:pass@sodialed.com/setup/abc',
			'https://sodialed.com:444/setup/abc',
			'https://sodialed.com/not-a-setup/abc',
		])
			expect(isSupportedSoDialedUrl(url)).toBe(false);
	});
});
