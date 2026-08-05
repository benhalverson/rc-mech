import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { Injectable } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, throwError } from 'rxjs';
import {
	SoDialedImporterClient,
	SoDialedImportPreview,
} from './setup-snapshot';
import { SetupSnapshots } from './setup-snapshots';

type Harness = {
	form: { set(value: unknown): void };
	openAdd(): void;
	makeCurrent(): void;
	copy(): void;
	save(): void;
	updateImportUrl(value: string): void;
	previewImport(): void;
	cancelImport(): void;
};

const preview: SoDialedImportPreview = {
	source: {
		url: 'https://sodialed.com/setup/abc',
		pdfUrl: 'https://sodialed.com/setup/abc.pdf',
		pdfTitle: 'ABC setup sheet',
	},
	carIdentity: { make: 'Team Associated', model: 'B6.4' },
	context: { track: 'Home clay', condition: 'Dry', recordedAt: '2026-08-04' },
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
};

@Injectable()
class MockImporter extends SoDialedImporterClient {
	result: Observable<SoDialedImportPreview> = of(preview);

	override preview(): Observable<SoDialedImportPreview> {
		return this.result;
	}
}

describe('SetupSnapshots', () => {
	let fixture: ComponentFixture<SetupSnapshots>;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [SetupSnapshots],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideNoopAnimations(),
				{ provide: SoDialedImporterClient, useClass: MockImporter },
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(SetupSnapshots);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	const currentSetup = {
		id: 'setup-1',
		carId: 'car-1',
		name: 'Clay baseline',
		current: true,
		context: {
			track: 'Home track',
			condition: 'Dry',
			recordedAt: '2026-08-01',
		},
		sections: {
			vehicle: { rideHeight: '22mm' },
			drivetrain: {},
			electronics: {},
			tires: {},
			shocks: {},
			frontSuspension: {},
			rearSuspension: {},
			notes: {},
		},
		source: {
			url: 'https://example.test/setup',
			pdfUrl: 'https://example.test/setup.pdf',
			pdfTitle: 'Sheet 1',
			pdfPage: 1,
		},
		unmappedValues: { casterDiagram: 'review' },
	};

	it('lists the current setup and retains source/unmapped values in the readout', () => {
		http
			.expectOne('/api/v1/cars/car-1/setups')
			.flush({ setups: [currentSetup] });
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain('Clay baseline');
		expect(fixture.nativeElement.textContent).toContain('Open source link');
		expect(fixture.nativeElement.textContent).toContain(
			'Unmapped / raw values',
		);
	});

	it('creates an optional baseline through the setup collection endpoint', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.form.set({
			name: 'Quick baseline',
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
			sections: {
				vehicle: { rideHeight: '' },
				drivetrain: {},
				electronics: {},
				tires: {},
				shocks: {},
				frontSuspension: {},
				rearSuspension: {},
				notes: {},
			},
		});
		fixture.detectChanges();
		app.save();
		const request = http.expectOne(
			(item) =>
				item.url === '/api/v1/cars/car-1/setups' && item.method === 'POST',
		);
		expect(request.request.body.name).toBe('Quick baseline');
		expect(request.request.body.track).toBeNull();
		request.flush({
			setup: {
				...currentSetup,
				id: 'setup-2',
				name: 'Quick baseline',
				current: false,
			},
		});
	});

	it('copies a setup and can select the copied snapshot as current', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({
			setups: [
				currentSetup,
				{
					...currentSetup,
					id: 'setup-0',
					name: 'Old baseline',
					current: false,
				},
			],
		});
		const app = fixture.componentInstance as unknown as Harness;
		fixture.detectChanges();
		app.copy();
		const copy = http.expectOne('/api/v1/cars/car-1/setups/setup-1/copy');
		copy.flush({
			setup: {
				...currentSetup,
				id: 'setup-2',
				name: 'Clay baseline copy',
				current: false,
				copiedFromSetupId: 'setup-1',
			},
		});
		fixture.detectChanges();
		app.makeCurrent();
		const current = http.expectOne('/api/v1/cars/car-1/setups/setup-2/current');
		expect(current.request.method).toBe('POST');
		current.flush({ setup: { ...currentSetup, id: 'setup-2', current: true } });
	});

	it('rejects malformed URLs before asking the importer to read a source', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://example.com/not-sodialed');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'supported So Dialed URL',
		);
	});

	it('shows a source review draft with mapped, uncertain, raw, and duplicate data', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		importer.result = of({
			...preview,
			duplicate: { setupId: 'setup-old', name: 'Earlier import' },
		});
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Team Associated B6.4');
		expect(fixture.nativeElement.textContent).toContain('Earlier import');
		expect(fixture.nativeElement.textContent).toContain('1 uncertain');
		expect(fixture.nativeElement.textContent).toContain('Raw source values');
	});

	it('keeps source review cancelable and saves the edited draft as a new snapshot', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Save as new snapshot');
		app.cancelImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain(
			'Import review draft',
		);
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		app.save();
		const request = http.expectOne(
			(item) =>
				item.url === '/api/v1/cars/car-1/setups' && item.method === 'POST',
		);
		expect(request.request.body.sourceUrl).toBe(preview.source.url);
		expect(request.request.body.rawValues).toEqual(preview.rawValues);
		request.flush({
			setup: { ...currentSetup, id: 'setup-imported', name: 'Imported setup' },
		});
	});

	it('reports an unavailable source without opening a review form', () => {
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		importer.result = throwError(() => new Error('Source is unavailable.'));
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/missing');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Source is unavailable.',
		);
		expect(fixture.nativeElement.textContent).not.toContain(
			'Import review draft',
		);
	});
});
