import { describe, expect, it } from 'vitest';
import {
	emptySetupForm,
	importKnownValues,
	parseSetupJsonObject,
	setupFormFromImport,
	setupFormFromSnapshot,
	setupPayloadFromForm,
} from './setup-form';
import {
	setupSectionKeys,
	type SetupSections,
	type SetupSnapshot,
	type SoDialedImportPreview,
} from './setup-snapshot';

const emptySections = (): SetupSections =>
	Object.fromEntries(setupSectionKeys.map((key) => [key, {}])) as SetupSections;

const snapshot = (overrides: Partial<SetupSnapshot> = {}): SetupSnapshot => ({
	id: 'setup-1',
	carId: 'car-1',
	name: 'Baseline',
	sections: emptySections(),
	...overrides,
});

const preview = (
	overrides: Partial<SoDialedImportPreview> = {},
): SoDialedImportPreview => ({
	draftId: 'draft-1',
	source: {},
	carIdentity: {},
	context: {},
	sections: emptySections(),
	uncertainValues: {},
	unmappedValues: {},
	rawValues: {},
	...overrides,
});

describe('setup form mapping', () => {
	it('maps complete and empty snapshots into editable values', () => {
		const complete = setupFormFromSnapshot(
			snapshot({
				context: {
					recordedAt: '2026-08-01T00:00:00.000Z',
					track: 'Home',
					event: 'Club race',
					surface: 'Clay',
					traction: 'High',
					moisture: 'Dry',
					condition: 'Grooved',
					temperature: '75 F',
				},
				source: {
					url: 'https://example.test/setup',
					pdfUrl: 'https://example.test/setup.pdf',
					pdfTitle: 'Sheet',
					pdfPage: 2,
				},
				sections: {
					...emptySections(),
					vehicle: { rideHeight: '22mm', weight: null },
				},
				unmappedValues: { diagram: true },
				rawValues: { source: 'raw' },
			}),
		);
		expect(complete).toMatchObject({
			recordedAt: '2026-08-01',
			track: 'Home',
			pdfPage: '2',
			unmappedValues: expect.stringContaining('diagram'),
			rawValues: expect.stringContaining('source'),
		});
		expect(complete.sections.vehicle['weight']).toBe('');

		const minimal = setupFormFromSnapshot(
			snapshot({
				context: null,
				source: null,
				unmappedValues: null,
				rawValues: null,
			}),
		);
		expect(minimal).toMatchObject({
			recordedAt: '',
			track: '',
			event: '',
			surface: '',
			traction: '',
			moisture: '',
			condition: '',
			temperature: '',
			sourceUrl: '',
			pdfUrl: '',
			pdfTitle: '',
			pdfPage: '',
			unmappedValues: '',
			rawValues: '',
		});
	});

	it('fills a missing section with its editable defaults', () => {
		const sections = emptySections();
		Reflect.deleteProperty(sections, 'vehicle');
		const form = setupFormFromSnapshot(snapshot({ sections }));
		expect(form.sections.vehicle['rideHeight']).toBe('');
	});

	it('selects import names and provenance fallbacks in priority order', () => {
		const titled = setupFormFromImport(
			preview({
				source: {
					title: '  Race setup  ',
					url: 'https://source.test/setup',
					pdfUrl: 'https://source.test/setup.pdf',
					pdfTitle: 'PDF title',
					pdfPage: 4,
				},
				carIdentity: { make: 'Associated', model: 'B6.4' },
				context: {
					recordedAt: '2026-08-01T00:00:00.000Z',
					track: 'Home',
					event: 'Race',
					surface: 'Clay',
					traction: 'High',
					moisture: 'Dry',
					condition: 'Grooved',
					temperature: '75 F',
				},
				uncertainValues: { one: true },
				unmappedValues: { two: true },
				rawValues: { raw: true },
			}),
			'https://fallback.test/setup',
		);
		expect(titled).toMatchObject({
			name: 'Race setup',
			sourceUrl: 'https://source.test/setup',
			pdfTitle: 'PDF title',
			pdfPage: '4',
			recordedAt: '2026-08-01',
			track: 'Home',
		});

		const identified = setupFormFromImport(
			preview({
				source: { title: '', pdfTitle: 'Fallback title' },
				carIdentity: { make: 'Associated', model: 'B6.4' },
			}),
			'https://fallback.test/setup',
		);
		expect(identified.name).toBe('Associated B6.4');
		expect(identified.sourceUrl).toBe('https://fallback.test/setup');
		expect(identified.pdfTitle).toBe('Fallback title');

		const fallback = setupFormFromImport(
			preview({ source: { title: 'Source title' }, carIdentity: {} }),
			'https://fallback.test/setup',
		);
		expect(fallback.name).toBe('Source title');
		expect(fallback.pdfTitle).toBe('Source title');
		const unnamed = setupFormFromImport(
			preview(),
			'https://fallback.test/setup',
		);
		expect(unnamed.name).toBe('Imported setup');
		expect(unnamed.pdfUrl).toBe('');
		expect(unnamed.pdfPage).toBe('');
	});

	it('parses object JSON and preserves malformed non-empty text', () => {
		expect(parseSetupJsonObject('{"a":1}')).toEqual({ a: 1 });
		expect(parseSetupJsonObject('null')).toEqual({});
		expect(parseSetupJsonObject('[1]')).toEqual({});
		expect(parseSetupJsonObject('bad json')).toEqual({ raw: 'bad json' });
		expect(parseSetupJsonObject('   ')).toEqual({});
	});

	it('builds a complete payload while dropping empty optional values', () => {
		const form = emptySetupForm();
		form.name = '  Race setup  ';
		form.recordedAt = '2026-08-01';
		form.track = ' Home ';
		form.event = ' Race ';
		form.surface = ' Clay ';
		form.traction = ' High ';
		form.moisture = ' Dry ';
		form.condition = ' Grooved ';
		form.temperature = ' 75 F ';
		form.sourceUrl = ' https://example.test/setup ';
		form.pdfUrl = ' https://example.test/setup.pdf ';
		form.pdfTitle = ' Sheet ';
		form.pdfPage = '3';
		form.unmappedValues = '{"diagram":true}';
		form.rawValues = '{"source":"raw"}';
		form.sections.vehicle['rideHeight'] = ' 22mm ';
		form.sections.drivetrain['motor'] = ' ';
		form.sections.notes['setupNotes'] = ' Notes ';
		Reflect.set(form.sections.vehicle, 'unknown', undefined);
		const payload = setupPayloadFromForm(form);
		expect(payload).toMatchObject({
			name: 'Race setup',
			setupDate: '2026-08-01T00:00:00.000Z',
			track: 'Home',
			event: 'Race',
			surface: 'Clay',
			traction: 'High',
			moisture: 'Dry',
			condition: 'Grooved',
			temperature: '75 F',
			vehicle: { rideHeight: '22mm' },
			notes: 'Notes',
			sourceUrl: 'https://example.test/setup',
			sourcePdfReference: 'Sheet',
			sourceMetadata: {
				pdfUrl: 'https://example.test/setup.pdf',
				pdfPage: 3,
			},
			unmappedValues: { diagram: true },
			rawValues: { source: 'raw' },
		});
		expect(
			importKnownValues({ ...payload, makeCurrent: true }).makeCurrent,
		).toBe(undefined);
	});

	it('uses nulls for every empty payload option', () => {
		const payload = setupPayloadFromForm(emptySetupForm());
		expect(payload).toMatchObject({
			setupDate: null,
			track: null,
			event: null,
			surface: null,
			traction: null,
			moisture: null,
			condition: null,
			temperature: null,
			notes: null,
			sourceUrl: null,
			sourcePdfReference: null,
			sourceMetadata: { pdfUrl: null, pdfPage: null },
			unmappedValues: null,
			rawValues: null,
		});
	});
});
