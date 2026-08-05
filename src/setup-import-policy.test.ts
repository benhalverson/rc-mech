import assert from 'node:assert/strict';
import { test } from 'vitest';
import {
	canonicalSetupImportUrl,
	defaultImportExtractor,
	resolveSetupImport,
	sourceKeyFor,
} from './setup-import-policy.ts';
import {
	setupImportAcceptInput,
	setupImportDraftInput,
	setupImportDraftUpdateInput,
} from './types.ts';

const supported = 'https://www.sodialed.com/setup/abc123?share=1#sheet';
const supportedWithoutWww = 'https://sodialed.com/setup/abc123';

test('import URL contract only accepts canonical So Dialed setup links', () => {
	assert.equal(
		canonicalSetupImportUrl(supported),
		'https://www.sodialed.com/setup/abc123',
	);
	assert.equal(
		canonicalSetupImportUrl('http://www.sodialed.com/setup/abc123'),
		null,
	);
	assert.equal(
		canonicalSetupImportUrl('https://example.com/setup/abc123'),
		null,
	);
	assert.equal(
		canonicalSetupImportUrl('https://www.sodialed.com/setup/abc/123'),
		null,
	);
	assert.equal(
		sourceKeyFor(supported),
		'https://www.sodialed.com/setup/abc123',
	);
	assert.equal(
		canonicalSetupImportUrl(supportedWithoutWww),
		sourceKeyFor(supported),
	);
	assert.equal(
		canonicalSetupImportUrl(
			'https://user:pass@www.sodialed.com:8443/setup/abc123',
		),
		null,
	);
});

test('resolver and extractor are injectable and preserve uncertain/raw values', async () => {
	const result = await resolveSetupImport(
		supported,
		async (url) => ({ canonicalUrl: url.toString(), html: '<html />' }),
		() => ({
			knownValues: { track: 'Club' },
			uncertainValues: { rearToe: { value: 'diagram', confidence: 0.4 } },
			rawValues: { original: 'rear toe diagram' },
			unmappedValues: { checkbox: 'yes' },
		}),
	);
	assert.deepEqual(result.knownValues, { track: 'Club' });
	assert.deepEqual(result.uncertainValues, {
		rearToe: { value: 'diagram', confidence: 0.4 },
	});
	assert.deepEqual(result.rawValues, { original: 'rear toe diagram' });
});

test('default extraction retains page metadata and only records HTTPS PDF references', async () => {
	const extracted = await defaultImportExtractor({
		canonicalUrl: 'https://www.sodialed.com/setup/abc123',
		html: '<meta property="og:title" content="Base setup"><meta property="og:description" content="Outdoor"><a href="https://files.example.test/setup.pdf">PDF</a>',
	});
	assert.deepEqual(extracted.sourceIdentity, { title: 'Base setup' });
	assert.equal(
		extracted.sourcePdfReference,
		'https://files.example.test/setup.pdf',
	);
	assert.deepEqual(extracted.rawValues, {
		title: 'Base setup',
		description: 'Outdoor',
	});
});

test('draft editing and acceptance contracts require ownership scope', () => {
	assert.equal(
		setupImportDraftInput.safeParse({ sourceUrl: supported }).success,
		true,
	);
	assert.equal(
		setupImportDraftUpdateInput.safeParse({ rawValues: { a: 'b' } }).success,
		true,
	);
	assert.equal(setupImportDraftUpdateInput.safeParse({}).success, false);
	assert.equal(
		setupImportAcceptInput.safeParse({ carId: 'car-1' }).success,
		true,
	);
});
