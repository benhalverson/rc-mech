import { globSync, readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const read = (path: string): string => readFileSync(path, 'utf8');

describe('Chassis Notes product contract', () => {
	test('keeps the repository name out of user-facing brand surfaces', () => {
		const userFacingFiles = [
			...globSync(['client/src/app/**/*.html', 'client/src/app/**/*.ts'], {
				exclude: ['**/*.spec.ts'],
			}),
			...globSync('docs/**/*.md', {
				exclude: ['docs/chassis-notes-landing-page.md'],
			}),
			'client/src/index.html',
			'src/auth.ts',
			'src/index.ts',
			'src/openapi.ts',
		];

		for (const file of userFacingFiles) {
			expect(read(file), file).not.toContain('RC Mech');
		}
	});

	test('preserves compatibility-sensitive rc-mech identifiers', () => {
		expect(read('package.json')).toContain('"name": "rc-mech"');
		const wrangler = read('wrangler.jsonc');
		expect(wrangler).toContain('"name": "rc-mech"');
		expect(wrangler).toContain('"database_name": "rc-mech"');
		expect(wrangler).toContain('"bucket_name": "rc-mech-photos"');
		expect(read('src/index.ts')).toContain("service: 'rc-mech'");
		expect(read('client/src/app/appearance.service.ts')).toContain(
			"'rc-mech.appearance'",
		);
		expect(read('client/src/app/voice/voice-offline-queue.ts')).toContain(
			"'rc-mech-voice-queue'",
		);
		expect(read('src/voice-processing.ts')).toContain(
			"['rc-mech', 'voice-track-log']",
		);
	});

	test('keeps naming authorities and public copy aligned', () => {
		const glossary = read('CONTEXT.md');
		for (const term of [
			'**Chassis Notes**',
			'**Racer**',
			'**User**',
			'**Garage**',
			'**Setup**',
			'**Drive session**',
			'**Trackside observation**',
		]) {
			expect(glossary).toContain(term);
		}

		expect(read('docs/adr/0013-chassis-notes-product-name.md')).toContain(
			'The product is named **Chassis Notes**',
		);
		expect(
			read('docs/adr/0014-extend-alloy-to-public-product-pages.md'),
		).toContain(
			'Public Chassis Notes product pages use the same Alloy visual language',
		);
		const brief = read('docs/chassis-notes-landing-page.md');
		expect(brief).toContain('**Status:** accepted');
		expect(brief).toContain(
			'The canonical product term is **Drive session**, never Run.',
		);
		expect(brief).toContain('it does not provide setup advice');

		const landing = read('client/src/app/landing/landing.html');
		expect(landing).toContain('Your Garage stays yours.');
		expect(landing).toContain(
			'Chassis Notes records observations and decisions. It does not provide setup advice.',
		);
		expect(landing).not.toContain('RC Mech');
	});
});
