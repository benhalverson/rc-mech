import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
	SetupSnapshotService,
	SoDialedImporterClient,
	type SoDialedImportPreview,
} from './setup-snapshot';

describe('setup snapshot clients', () => {
	let http: HttpTestingController;
	let importer: SoDialedImporterClient;
	let snapshots: SetupSnapshotService;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SoDialedImporterClient,
				SetupSnapshotService,
			],
		});
		http = TestBed.inject(HttpTestingController);
		importer = TestBed.inject(SoDialedImporterClient);
		snapshots = TestBed.inject(SetupSnapshotService);
	});

	afterEach(() => http.verify());

	it('accepts only owner-safe So Dialed setup URLs', () => {
		expect(
			SoDialedImporterClient.isSupportedUrl(
				' https://sodialed.com/setup/Abc123/ ',
			),
		).toBe(true);
		expect(
			SoDialedImporterClient.isSupportedUrl(
				'https://www.sodialed.com:443/setup/abc',
			),
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
			expect(SoDialedImporterClient.isSupportedUrl(url)).toBe(false);
	});

	it('rejects unsupported previews without an HTTP request', () => {
		let message = '';
		importer.preview('https://example.com/setup/nope', 'car-1').subscribe({
			error: (error: unknown) => {
				message = error instanceof Error ? error.message : '';
			},
		});
		expect(message).toContain('supported So Dialed URL');
		http.expectNone('/api/v1/setup-imports/drafts');
	});

	it('maps a complete import draft into a review preview', () => {
		let preview: SoDialedImportPreview | undefined;
		importer
			.preview(' https://sodialed.com/setup/abc ', 'car-1')
			.subscribe((value) => {
				preview = value;
			});
		const request = http.expectOne('/api/v1/setup-imports/drafts');
		expect(request.request.body).toEqual({
			sourceUrl: 'https://sodialed.com/setup/abc',
			carId: 'car-1',
		});
		request.flush({
			draft: {
				id: 'draft-1',
				sourceUrl: 'https://sodialed.com/setup/abc',
				sourceIdentity: { name: 'B6.4', make: 'Associated', model: 'RC10' },
				source: {
					url: 'https://sodialed.com/setup/abc',
					hasPdfReference: true,
					metadata: { pdfPage: 3, title: 'Setup sheet' },
				},
				knownValues: {
					context: { track: 'Home' },
					sections: {
						vehicle: {},
						drivetrain: {},
						electronics: {},
						tires: {},
						shocks: {},
						frontSuspension: {},
						rearSuspension: {},
						notes: {},
					},
				},
				uncertainValues: { caster: 'review' },
				rawValues: { raw: true },
				unmappedValues: { other: true },
			},
		});
		expect(preview).toMatchObject({
			draftId: 'draft-1',
			source: { pdfTitle: 'Original setup PDF', pdfPage: 3 },
			carIdentity: { name: 'B6.4', make: 'Associated', model: 'RC10' },
			context: { track: 'Home' },
		});
	});

	it('maps absent and malformed import metadata to safe defaults', () => {
		let preview: SoDialedImportPreview | undefined;
		importer
			.preview('https://sodialed.com/setup/fallback', 'car-1')
			.subscribe((value) => {
				preview = value;
			});
		http.expectOne('/api/v1/setup-imports/drafts').flush({
			draft: {
				id: 'draft-fallback',
				sourceUrl: 'https://sodialed.com/setup/fallback',
				sourceIdentity: { name: 1, make: null, model: false },
				source: {
					url: 'https://sodialed.com/setup/fallback',
					hasPdfReference: false,
					metadata: { pdfPage: 'three' },
				},
				knownValues: {},
				uncertainValues: {},
				rawValues: {},
				unmappedValues: {},
			},
		});
		expect(preview?.source.pdfTitle).toBeNull();
		expect(preview?.source.pdfPage).toBeNull();
		expect(preview?.carIdentity).toEqual({
			name: null,
			make: null,
			model: null,
		});
		expect(preview?.context).toEqual({});
		expect(Object.keys(preview?.sections ?? {})).toHaveLength(8);
	});

	it('updates, cancels, and accepts import drafts with credentials', () => {
		importer.update('draft/1', { carId: 'car-2' }).subscribe();
		const update = http.expectOne('/api/v1/setup-imports/drafts/draft/1');
		expect(update.request.method).toBe('PATCH');
		update.flush({ draft: { id: 'draft/1' } });

		importer.cancel('draft/1').subscribe();
		const cancel = http.expectOne(
			'/api/v1/setup-imports/drafts/draft/1/cancel',
		);
		expect(cancel.request.method).toBe('POST');
		cancel.flush(null);

		importer.accept('draft/1', 'car-2', 'Imported').subscribe();
		const accept = http.expectOne(
			'/api/v1/setup-imports/drafts/draft/1/accept',
		);
		expect(accept.request.body).toEqual({
			carId: 'car-2',
			name: 'Imported',
			makeCurrent: false,
		});
		accept.flush({ setup: {} });
	});

	it('uses encoded owner-scoped endpoints for every snapshot mutation', () => {
		const payload = { name: 'Setup' };
		snapshots.create('car/1', payload).subscribe();
		const create = http.expectOne('/api/v1/cars/car%2F1/setups');
		expect(create.request.method).toBe('POST');
		create.flush({ setup: {} });

		snapshots.update('car/1', 'setup/1', payload).subscribe();
		const update = http.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1');
		expect(update.request.method).toBe('PATCH');
		update.flush({ setup: {} });

		snapshots.copy('car/1', 'setup/1').subscribe();
		const copy = http.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1/copy');
		expect(copy.request.method).toBe('POST');
		copy.flush({ setup: {} });

		snapshots.selectCurrent('car/1', 'setup/1').subscribe();
		const current = http.expectOne(
			'/api/v1/cars/car%2F1/setups/setup%2F1/current',
		);
		expect(current.request.method).toBe('POST');
		current.flush({ setup: {} });
	});
});
