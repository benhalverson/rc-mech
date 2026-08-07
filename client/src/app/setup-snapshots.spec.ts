import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { Injectable } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, throwError } from 'rxjs';
import { vi } from 'vitest';
import { emptySetupForm } from './setup-form';
import {
	SoDialedImporterClient,
	SoDialedImportPreview,
} from './setup-snapshot';
import { SetupSnapshots } from './setup-snapshots';

type Harness = {
	formModel: { set(value: unknown): void };
	importCarModel: { set(value: { carId: string }): void };
	openAdd(): void;
	copyPrevious(): void;
	openEdit(): void;
	makeCurrent(): void;
	copy(): void;
	save(): void;
	updateImportUrl(value: string): void;
	previewImport(): void;
	cancelImport(): void;
};

const preview: SoDialedImportPreview = {
	draftId: 'draft-1',
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

	const flushSetups = async (setups: unknown[] = []): Promise<void> => {
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars/car-1/setups');
		});
		request?.flush({ setups });
		await fixture.whenStable();
		fixture.detectChanges();
	};

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

	it('lists the current setup and retains source/unmapped values in the readout', async () => {
		await flushSetups([currentSetup]);

		expect(fixture.nativeElement.textContent).toContain('Clay baseline');
		expect(fixture.nativeElement.textContent).toContain('Open source link');
		expect(fixture.nativeElement.textContent).toContain(
			'Unmapped / raw values',
		);
	});

	it('shows a loading state before setup history returns', () => {
		expect(fixture.nativeElement.textContent).toContain(
			'Reading setup history',
		);
		http.expectOne('/api/v1/cars/car-1/setups').flush({ setups: [] });
	});

	it('renders and retries a setup history read error', async () => {
		http
			.expectOne('/api/v1/cars/car-1/setups')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();

		const retry = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.includes('Try again'),
		) as HTMLButtonElement | undefined;
		retry?.click();
		await flushSetups();
		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
	});

	it('guides an owner to record the first baseline when history is empty', async () => {
		await flushSetups();

		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
		expect(fixture.nativeElement.textContent).toContain(
			'Record the first setup',
		);
	});

	it('creates an optional baseline through the setup collection endpoint', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.formModel.set({
			...emptySetupForm(),
			name: 'Quick baseline',
			pdfUrl: 'legacy-pdf-reference',
		});
		fixture.detectChanges();
		app.save();
		const request = http.expectOne(
			(item) =>
				item.url === '/api/v1/cars/car-1/setups' && item.method === 'POST',
		);
		expect(request.request.body.name).toBe('Quick baseline');
		expect(request.request.body.track).toBeNull();
		expect(request.request.body.sourceMetadata.pdfUrl).toBe(
			'legacy-pdf-reference',
		);
		request.flush({
			setup: {
				...currentSetup,
				id: 'setup-2',
				name: 'Quick baseline',
				current: false,
			},
		});
		await flushSetups([
			{ ...currentSetup, id: 'setup-2', name: 'Quick baseline' },
		]);
	});

	it('announces review validation and focuses the first invalid typed field', async () => {
		await flushSetups();
		const open = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.includes('Record the first setup'),
		) as HTMLButtonElement | undefined;
		open?.click();
		fixture.detectChanges();
		const editor = fixture.nativeElement.querySelector(
			'form.setup-editor',
		) as HTMLFormElement;
		expect(editor.getAttribute('aria-describedby')).toBeNull();
		editor.dispatchEvent(new Event('submit'));
		fixture.detectChanges();

		const name = editor.querySelector('input') as HTMLInputElement;
		expect(editor.getAttribute('aria-describedby')).toBe(
			'setup-form-validation',
		);
		expect(
			editor.querySelector('#setup-form-validation[role="alert"]')?.textContent,
		).toContain('Name this setup before saving');
		expect(document.activeElement).toBe(name);

		name.value = 'Valid setup';
		name.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		expect(editor.getAttribute('aria-describedby')).toBeNull();
		expect(editor.querySelector('#setup-form-validation')).toBeNull();
	});

	it('focuses the first invalid optional field in editor order', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.formModel.set({
			...emptySetupForm(),
			name: 'Valid setup',
			track: 'x'.repeat(161),
		});
		fixture.detectChanges();
		const editor = fixture.nativeElement.querySelector(
			'form.setup-editor',
		) as HTMLFormElement;
		editor.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const trackInput = [...editor.querySelectorAll('label')]
			.find((label) => label.textContent?.trim().startsWith('Track'))
			?.querySelector('input');

		expect(document.activeElement).toBe(trackInput);
	});

	it('copies a setup and can select the copied snapshot as current', async () => {
		await flushSetups([
			currentSetup,
			{
				...currentSetup,
				id: 'setup-0',
				name: 'Old baseline',
				current: false,
			},
		]);
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
		await flushSetups([
			currentSetup,
			{
				...currentSetup,
				id: 'setup-2',
				name: 'Clay baseline copy',
				current: false,
			},
		]);
		app.makeCurrent();
		const current = http.expectOne('/api/v1/cars/car-1/setups/setup-2/current');
		expect(current.request.method).toBe('POST');
		current.flush({ setup: { ...currentSetup, id: 'setup-2', current: true } });
		await flushSetups([
			{ ...currentSetup, current: false },
			{ ...currentSetup, id: 'setup-2', current: true },
		]);
	});

	it('copies the current setup by default even when an older history row is selected', async () => {
		await flushSetups([
			currentSetup,
			{
				...currentSetup,
				id: 'setup-0',
				name: 'Old baseline',
				current: false,
			},
		]);
		const app = fixture.componentInstance as unknown as Harness;
		app.copyPrevious();
		const request = http.expectOne('/api/v1/cars/car-1/setups/setup-1/copy');
		expect(request.request.method).toBe('POST');
		request.flush({
			setup: { ...currentSetup, id: 'setup-2', name: 'New baseline' },
		});
		await flushSetups([
			currentSetup,
			{ ...currentSetup, id: 'setup-2', name: 'New baseline' },
		]);
	});

	it('opens the same grouped editor for an existing setup', async () => {
		await flushSetups([currentSetup]);
		const app = fixture.componentInstance as unknown as Harness;
		app.openEdit();
		fixture.detectChanges();

		expect(
			fixture.nativeElement.querySelector('form.setup-editor'),
		).toBeTruthy();
		expect(fixture.nativeElement.textContent).toContain('Drivetrain');
		expect(fixture.nativeElement.textContent).toContain(
			'Source and provenance',
		);
	});

	it('keeps archived setup history readable and removes mutation controls', async () => {
		fixture.componentRef.setInput('archived', true);
		await flushSetups([currentSetup]);

		expect(fixture.nativeElement.textContent).toContain('This car is archived');
		expect(fixture.nativeElement.textContent).toContain('Clay baseline');
		expect(
			fixture.nativeElement.querySelector('button:not(.setup-row)'),
		).toBeNull();
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

	it('associates Signal Form validation with the import field and restores focus', async () => {
		await flushSetups();
		const input = fixture.nativeElement.querySelector(
			'#sodialed-url',
		) as HTMLInputElement;
		input.value = 'https://example.com/not-sodialed';
		input.dispatchEvent(new Event('input'));
		input.closest('form')?.dispatchEvent(new Event('submit'));
		fixture.detectChanges();

		expect(input.getAttribute('aria-describedby')).toBe(
			'import-url-validation',
		);
		expect(
			fixture.nativeElement.querySelector(
				'#import-url-validation[role="alert"]',
			)?.textContent,
		).toContain('supported So Dialed URL');
		expect(document.activeElement).toBe(input);
	});

	it('shows a source review draft with mapped, uncertain, raw, and duplicate data', async () => {
		await flushSetups();
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

	it('keeps source review cancelable and saves the edited draft as a new snapshot', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Save as new snapshot');
		app.cancelImport();
		http
			.expectOne('/api/v1/setup-imports/drafts/draft-1/cancel')
			.flush({ ok: true });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain(
			'Import review draft',
		);
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		app.save();
		const update = http.expectOne('/api/v1/setup-imports/drafts/draft-1');
		expect(update.request.method).toBe('PATCH');
		expect(update.request.body.knownValues.name).toBe('Team Associated B6.4');
		expect(update.request.body.rawValues).toEqual(preview.rawValues);
		update.flush({ draft: { id: 'draft-1' } });
		const accept = http.expectOne(
			'/api/v1/setup-imports/drafts/draft-1/accept',
		);
		expect(accept.request.body).toEqual({
			carId: 'car-1',
			name: 'Team Associated B6.4',
			makeCurrent: false,
		});
		accept.flush({
			setup: {
				...currentSetup,
				id: 'setup-imported',
				name: 'Team Associated B6.4',
			},
		});
		await flushSetups([
			{
				...currentSetup,
				id: 'setup-imported',
				name: 'Team Associated B6.4',
			},
		]);
	});

	it('announces an import saved to another car as a status', async () => {
		fixture.componentRef.setInput('availableCars', [
			{ id: 'car-1', name: 'Red Runner' },
			{ id: 'car-2', name: 'Blue Runner' },
		]);
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		app.importCarModel.set({ carId: 'car-2' });
		app.save();
		const update = http.expectOne('/api/v1/setup-imports/drafts/draft-1');
		expect(update.request.body.carId).toBe('car-2');
		update.flush({ draft: { id: 'draft-1' } });
		const accept = http.expectOne(
			'/api/v1/setup-imports/drafts/draft-1/accept',
		);
		expect(accept.request.body.carId).toBe('car-2');
		accept.flush({
			setup: {
				...currentSetup,
				id: 'setup-imported',
				carId: 'car-2',
				name: 'Team Associated B6.4',
			},
		});
		fixture.detectChanges();

		const status = [
			...fixture.nativeElement.querySelectorAll('[role="status"]'),
		].find((element: HTMLElement) =>
			element.textContent?.includes('saved to the selected car'),
		);
		expect(status).toBeTruthy();
		expect(
			[...fixture.nativeElement.querySelectorAll('[role="alert"]')].some(
				(element: HTMLElement) =>
					element.textContent?.includes('saved to the selected car'),
			),
		).toBe(false);
		expect(
			[...fixture.nativeElement.querySelectorAll('button')].some(
				(button: HTMLButtonElement) =>
					button.textContent?.includes('Try again'),
			),
		).toBe(false);
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
