import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseSetupCollection,
	parseSetupMutation,
	type SetupSnapshot,
	SetupSnapshotGateway,
	SoDialedImportGateway,
	type SoDialedImportPreview,
	setupGatewayFailure,
} from './setup-snapshot';

const snapshot = (id = 'setup-1', carId = 'car-1'): SetupSnapshot => ({
	id,
	carId,
	name: 'Setup',
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
});

describe('setup snapshot clients', () => {
	let http: HttpTestingController;
	let importer: SoDialedImportGateway;
	let snapshots: SetupSnapshotGateway;

	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				SoDialedImportGateway,
				SetupSnapshotGateway,
			],
		});
		http = TestBed.inject(HttpTestingController);
		importer = TestBed.inject(SoDialedImportGateway);
		snapshots = TestBed.inject(SetupSnapshotGateway);
	});

	afterEach(() => http.verify());

	it('parses snapshot responses and maps all canonical failures', () => {
		expect(parseSetupCollection({ setups: [snapshot()] })).toEqual([
			snapshot(),
		]);
		expect(parseSetupMutation({ setup: snapshot() })).toEqual(snapshot());
		expect(() => parseSetupCollection({ setups: [{ id: 4 }] })).toThrow();
		expect(() => parseSetupMutation({ setup: null })).toThrow();
		expect(setupGatewayFailure(new HttpErrorResponse({ status: 0 }))).toEqual({
			kind: 'unavailable',
		});
		expect(setupGatewayFailure(new HttpErrorResponse({ status: 401 }))).toEqual(
			{ kind: 'http', status: 401 },
		);
		expect(setupGatewayFailure(new Error('Rejected setup'))).toEqual({
			kind: 'rejected',
			message: 'Rejected setup',
		});
		expect(setupGatewayFailure('offline')).toEqual({ kind: 'unavailable' });
		let malformed: unknown;
		try {
			parseSetupMutation({ setup: {} });
		} catch (error) {
			malformed = error;
		}
		expect(setupGatewayFailure(malformed)).toEqual({
			kind: 'invalid-response',
		});
	});

	it('loads, refreshes, and validates one selected snapshot collection', async () => {
		snapshots.collection.value();
		http.expectNone('/api/v1/cars/car%2F1/setups');
		expect(snapshots.failure()).toBeNull();
		snapshots.selectCar('car/1');
		snapshots.selectCar('car/1');
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne('/api/v1/cars/car%2F1/setups');
		});
		expect(read?.request.withCredentials).toBe(true);
		read?.flush({ setups: [snapshot('setup-1', 'car/1')] });
		await vi.waitFor(() =>
			expect(snapshots.collection.value()).toHaveLength(1),
		);

		snapshots.refresh();
		let refresh: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car%2F1/setups');
		});
		refresh?.flush({ setups: [{ id: 4 }] });
		await vi.waitFor(() => expect(snapshots.collection.error()).toBeTruthy());
		expect(snapshots.failure()).toEqual({ kind: 'invalid-response' });
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

	it('ignores null and non-object import metadata', () => {
		for (const [index, metadata] of [null, 'invalid', ['invalid']].entries()) {
			let preview: SoDialedImportPreview | undefined;
			const url = `https://sodialed.com/setup/fallback${index}`;
			importer.preview(url, 'car-1').subscribe((value) => {
				preview = value;
			});
			http.expectOne('/api/v1/setup-imports/drafts').flush({
				draft: {
					id: `draft-fallback-${index}`,
					sourceUrl: url,
					sourceIdentity: {},
					source: { url, hasPdfReference: false, metadata },
					knownValues: {},
					uncertainValues: {},
					rawValues: {},
					unmappedValues: {},
				},
			});
			expect(preview?.source).toEqual({
				url,
				pdfUrl: null,
				pdfTitle: null,
				pdfPage: null,
			});
		}
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
		cancel.flush({ ok: true });

		importer.accept('draft/1', 'car-2', 'Imported').subscribe();
		const accept = http.expectOne(
			'/api/v1/setup-imports/drafts/draft/1/accept',
		);
		expect(accept.request.body).toEqual({
			carId: 'car-2',
			name: 'Imported',
			makeCurrent: false,
		});
		accept.flush({ setup: snapshot('setup-imported', 'car-2') });
	});

	it('rejects a malformed import cancellation acknowledgement', () => {
		let failure: unknown;
		importer.cancel('draft-1').subscribe({
			error: (error: unknown) => {
				failure = error;
			},
		});
		http.expectOne('/api/v1/setup-imports/drafts/draft-1/cancel').flush(null);
		expect(failure).toEqual({ kind: 'invalid-response' });
	});

	it('uses encoded owner-scoped endpoints for every snapshot mutation', () => {
		const payload = { name: 'Setup' };
		snapshots.create('car/1', payload).subscribe();
		const create = http.expectOne('/api/v1/cars/car%2F1/setups');
		expect(create.request.method).toBe('POST');
		create.flush({ setup: snapshot('setup-created', 'car/1') });

		snapshots.update('car/1', 'setup/1', payload).subscribe();
		const update = http.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1');
		expect(update.request.method).toBe('PATCH');
		update.flush({ setup: snapshot('setup/1', 'car/1') });

		snapshots.copy('car/1', 'setup/1').subscribe();
		const copy = http.expectOne('/api/v1/cars/car%2F1/setups/setup%2F1/copy');
		expect(copy.request.method).toBe('POST');
		copy.flush({ setup: snapshot('setup-copy', 'car/1') });

		snapshots.selectCurrent('car/1', 'setup/1').subscribe();
		const current = http.expectOne(
			'/api/v1/cars/car%2F1/setups/setup%2F1/current',
		);
		expect(current.request.method).toBe('POST');
		current.flush({ setup: snapshot('setup/1', 'car/1') });
	});
});
