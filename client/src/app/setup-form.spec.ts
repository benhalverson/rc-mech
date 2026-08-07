import { describe, expect, it } from 'vitest';
import {
	emptySetupForm,
	importKnownValues,
	parseSetupJsonObject,
	setupFormFromImport,
	setupPayloadFromForm,
} from './setup-form';
import type { SoDialedImportPreview } from './setup-snapshot';

const preview: SoDialedImportPreview = {
	draftId: 'draft-1',
	source: {
		url: 'https://sodialed.com/setup/abc',
		pdfUrl: 'https://sodialed.com/setup/abc.pdf',
		pdfTitle: 'Original sheet',
		pdfPage: 2,
	},
	carIdentity: { make: 'Team Associated', model: 'B6.4' },
	context: { recordedAt: '2026-08-04', track: 'Home clay' },
	sections: {
		vehicle: { rideHeight: '22mm' },
		drivetrain: { pinion: '27T' },
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	uncertainValues: { casterDiagram: 'review' },
	unmappedValues: { checkbox: 'unknown' },
	rawValues: { sourceLabel: 'Caster' },
	duplicate: { setupId: 'setup-old', name: 'Earlier import' },
};

describe('setup form transformations', () => {
	it('creates an editable import model without losing provenance or review values', () => {
		const model = setupFormFromImport(
			preview,
			'https://sodialed.com/setup/fallback',
		);

		expect(model.name).toBe('Team Associated B6.4');
		expect(model.sections.vehicle['rideHeight']).toBe('22mm');
		expect(model.sourceUrl).toBe(preview.source.url);
		expect(model.pdfUrl).toBe(preview.source.pdfUrl);
		expect(JSON.parse(model.unmappedValues)).toEqual({
			uncertain: preview.uncertainValues,
			unmapped: preview.unmappedValues,
		});
		expect(JSON.parse(model.rawValues)).toEqual(preview.rawValues);
	});

	it('maps typed fields to the snapshot payload while retaining source values', () => {
		const model = {
			...emptySetupForm(),
			name: '  Clay baseline  ',
			recordedAt: '2026-08-04',
			track: '  Home clay ',
			sourceUrl: ' https://sodialed.com/setup/abc ',
			pdfUrl: 'https://sodialed.com/setup/abc.pdf',
			pdfTitle: ' Original sheet ',
			pdfPage: '2',
			sections: {
				...emptySetupForm().sections,
				vehicle: {
					...emptySetupForm().sections.vehicle,
					rideHeight: ' 22mm ',
				},
			},
			unmappedValues: JSON.stringify({ checkbox: 'unknown' }),
			rawValues: JSON.stringify({ sourceLabel: 'Caster' }),
		};

		const payload = setupPayloadFromForm(model);

		expect(payload).toMatchObject({
			name: 'Clay baseline',
			setupDate: '2026-08-04T00:00:00.000Z',
			track: 'Home clay',
			vehicle: { rideHeight: '22mm' },
			sourceUrl: 'https://sodialed.com/setup/abc',
			sourcePdfReference: 'Original sheet',
			sourceMetadata: {
				pdfUrl: 'https://sodialed.com/setup/abc.pdf',
				pdfPage: 2,
			},
			unmappedValues: { checkbox: 'unknown' },
			rawValues: { sourceLabel: 'Caster' },
		});
		expect(importKnownValues(payload).makeCurrent).toBeUndefined();
	});

	it('retains non-JSON source text instead of silently discarding it', () => {
		expect(parseSetupJsonObject('original caster diagram')).toEqual({
			raw: 'original caster diagram',
		});
	});
});
