import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { Injectable } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { Observable, of, Subject, throwError } from 'rxjs';
import { vi } from 'vitest';
import { emptySetupForm } from './setup-form';
import {
	SoDialedImporterClient,
	SoDialedImportPreview,
	type SetupSnapshot,
} from './setup-snapshot';
import { SetupSnapshotStore } from './setup-snapshot-store';
import { SetupSnapshots } from './setup-snapshots';

type Harness = {
	formModel: { set(value: unknown): void };
	importCarModel: { set(value: { carId: string }): void };
	setups: (() => SetupSnapshot[]) & { set(value: SetupSnapshot[]): void };
	selectedId: (() => string | null) & { set(value: string | null): void };
	action: (() => string | null) & { set(value: string | null): void };
	actionError: (() => string) & { set(value: string): void };
	formError: (() => string) & { set(value: string): void };
	importPreview: (() => SoDialedImportPreview | null) & {
		set(value: SoDialedImportPreview | null): void;
	};
	openAdd(): void;
	copyPrevious(): void;
	select(setup: SetupSnapshot): void;
	openEdit(): void;
	makeCurrent(): void;
	copy(): void;
	save(): void;
	updateImportUrl(value: string): void;
	previewImport(): void;
	cancelImport(): void;
	requestCreateCar(): void;
	displayName(field: string): string;
	importValueCount(values: Record<string, unknown>): number;
	sectionHasValues(values: Record<string, string | null>): boolean;
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
				SetupSnapshotStore,
				{ provide: SoDialedImporterClient, useClass: MockImporter },
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(SetupSnapshots);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	const flushSetups = async (
		setups: unknown[] = [],
		carId = 'car-1',
	): Promise<void> => {
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne(`/api/v1/cars/${carId}/setups`);
		});
		request?.flush({ setups });
		await fixture.whenStable();
		fixture.detectChanges();
	};

	it('waits for the car input before loading setup history', async () => {
		await flushSetups();
		fixture.destroy();
		fixture = TestBed.createComponent(SetupSnapshots);

		expect(() => fixture.detectChanges()).not.toThrow();
		http.expectNone((request) => request.url.includes('/setups'));
	});

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

	it('explains an expired session without retrying the protected read', async () => {
		http
			.expectOne('/api/v1/cars/car-1/setups')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();

		const alert = fixture.nativeElement.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
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

	it('ignores a stale import destination when recording a normal setup', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.importCarModel.set({ carId: 'car-2' });
		app.openAdd();
		app.formModel.set({
			...emptySetupForm(),
			name: 'Trackside baseline',
		});
		fixture.detectChanges();
		app.save();
		const request = http.expectOne(
			(item) =>
				item.url === '/api/v1/cars/car-1/setups' && item.method === 'POST',
		);
		request.flush({
			setup: {
				...currentSetup,
				id: 'setup-2',
				name: 'Trackside baseline',
				current: false,
			},
		});
		await flushSetups([
			{ ...currentSetup, id: 'setup-2', name: 'Trackside baseline' },
		]);
	});

	it('resets local state and ignores a stale import preview after route reuse', async () => {
		await flushSetups();
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		const pendingPreview = new Subject<SoDialedImportPreview>();
		importer.result = pendingPreview;
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();

		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		pendingPreview.next(preview);
		pendingPreview.complete();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
		expect(fixture.nativeElement.textContent).not.toContain(
			'Import review draft',
		);
		expect(fixture.nativeElement.querySelector('form.setup-editor')).toBeNull();
		expect(
			(fixture.nativeElement.querySelector('#sodialed-url') as HTMLInputElement)
				.value,
		).toBe('');
	});

	it('ignores a stale save response after route reuse', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.formModel.set({
			...emptySetupForm(),
			name: 'Old car baseline',
		});
		fixture.detectChanges();
		app.save();
		const save = http.expectOne(
			(item) =>
				item.url === '/api/v1/cars/car-1/setups' && item.method === 'POST',
		);

		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		save.flush({
			setup: {
				...currentSetup,
				name: 'Old car baseline',
			},
		});
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
		expect(fixture.nativeElement.textContent).not.toContain('Old car baseline');
		expect(fixture.nativeElement.querySelector('form.setup-editor')).toBeNull();
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
		expect(name.getAttribute('aria-describedby')).toBe('setup-form-validation');

		name.value = 'Valid setup';
		name.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		await fixture.whenStable();
		fixture.detectChanges();
		expect(editor.getAttribute('aria-describedby')).toBeNull();
		expect(editor.querySelector('#setup-form-validation')).toBeNull();
		expect(name.getAttribute('aria-describedby')).toBeNull();
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
		expect(trackInput?.getAttribute('aria-describedby')).toBe(
			'setup-form-validation',
		);
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

	it('reports a blank import URL as required without a format error', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('   ');
		app.previewImport();
		fixture.detectChanges();

		const validation = fixture.nativeElement.querySelector(
			'#import-url-validation[role="alert"]',
		);
		expect(validation?.textContent).toContain('Paste a So Dialed setup URL.');
		expect(validation?.textContent).not.toContain('supported So Dialed URL');
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

	it('explains when the garage session expires during source review', async () => {
		await flushSetups();
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		importer.result = throwError(() => ({ status: 401 }));
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/expired');
		app.previewImport();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'Your garage session has expired. Sign in again to continue.',
		);
	});

	it('selects rows, formats labels, counts review values, and detects section data', async () => {
		await flushSetups([currentSetup]);
		const app = fixture.componentInstance as unknown as Harness;
		app.select(currentSetup);
		expect(app.selectedId()).toBe('setup-1');
		expect(app.displayName('frontRideHeight')).toBe('Front Ride Height');
		expect(app.importValueCount({ one: 1, two: 2 })).toBe(2);
		expect(app.sectionHasValues({ empty: null, blank: '' })).toBe(false);
		expect(app.sectionHasValues({ value: '22mm' })).toBe(true);
	});

	it('emits every imported car identity fallback and ignores missing previews', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		const emitted: Array<{ name: string; make: string; model: string }> = [];
		fixture.componentInstance.createCarFromImport.subscribe((value) =>
			emitted.push(value),
		);
		app.requestCreateCar();
		for (const identity of [
			{ name: 'Named', make: 'Make', model: 'Model' },
			{ name: '', make: 'Make', model: 'Model' },
			{ name: '', make: '', model: '' },
		]) {
			app.importPreview.set({ ...preview, carIdentity: identity });
			app.requestCreateCar();
		}
		expect(emitted).toEqual([
			{ name: 'Named', make: 'Make', model: 'Model' },
			{ name: 'Make Model', make: 'Make', model: 'Model' },
			{ name: 'Imported car', make: '', model: '' },
		]);
	});

	it('guards mutations without a source, while archived, or while busy', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.copy();
		app.copyPrevious();
		app.makeCurrent();
		app.openEdit();
		http.expectNone((request) => request.method !== 'GET');

		app.setups.set([currentSetup]);
		app.select(currentSetup);
		app.makeCurrent();
		app.action.set('save');
		app.copy();
		app.makeCurrent();
		app.action.set(null);
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		app.copy();
		app.makeCurrent();
		app.openEdit();
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		http.expectNone((request) => request.method !== 'GET');
	});

	it('validates blank names, source URLs, and PDF page numbers', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.formModel.set({
			...emptySetupForm(),
			name: '   ',
			sourceUrl: 'ftp://example.test/setup',
			pdfPage: '0',
		});
		app.save();
		expect(app.formError()).toContain('Review the highlighted');
		app.formModel.set({
			...emptySetupForm(),
			name: 'Valid',
			sourceUrl: 'not a URL',
		});
		app.save();
		expect(app.formError()).toContain('Review the highlighted');
		app.formModel.set({
			...emptySetupForm(),
			name: 'Valid',
			sourceUrl: '',
			pdfPage: '0',
		});
		app.save();
		expect(app.formError()).toContain('Review the highlighted');
		app.formModel.set({
			...emptySetupForm(),
			name: 'Valid',
			sourceUrl: 'https://example.test/setup',
			pdfPage: '2',
		});
		app.action.set('save');
		app.save();
		http.expectNone((request) => request.method === 'POST');
	});

	it('maps current and generic setup save failures', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		for (const [status, message] of [
			[401, 'session has expired'],
			[500, 'could not be saved'],
		] as const) {
			app.openAdd();
			app.formModel.set({ ...emptySetupForm(), name: 'Baseline' });
			app.save();
			http
				.expectOne('/api/v1/cars/car-1/setups')
				.flush('failed', { status, statusText: 'Failed' });
			expect(app.formError()).toContain(message);
		}
	});

	it('updates an existing setup and replaces its local row', async () => {
		const previous = { ...currentSetup, id: 'setup-0', current: false };
		await flushSetups([currentSetup, previous]);
		const app = fixture.componentInstance as unknown as Harness;
		app.openEdit();
		app.formModel.set({ ...emptySetupForm(), name: 'Updated baseline' });
		app.save();
		const update = http.expectOne('/api/v1/cars/car-1/setups/setup-1');
		expect(update.request.method).toBe('PATCH');
		update.flush({ setup: { ...currentSetup, name: 'Updated baseline' } });
		await flushSetups([
			{ ...currentSetup, name: 'Updated baseline' },
			previous,
		]);
		expect(app.setups()[0]?.name).toBe('Updated baseline');
	});

	it('maps copy failures and ignores stale copy errors', async () => {
		await flushSetups([currentSetup]);
		const app = fixture.componentInstance as unknown as Harness;
		for (const [status, message] of [
			[401, 'session has expired'],
			[500, 'could not be copied'],
		] as const) {
			app.copy();
			http
				.expectOne('/api/v1/cars/car-1/setups/setup-1/copy')
				.flush('failed', { status, statusText: 'Failed' });
			expect(app.actionError()).toContain(message);
		}

		app.copy();
		const stale = http.expectOne('/api/v1/cars/car-1/setups/setup-1/copy');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		stale.flush('failed', { status: 500, statusText: 'Failed' });
		expect(app.actionError()).toBe('');
	});

	it('maps current-selection failures and ignores stale outcomes', async () => {
		const old = { ...currentSetup, id: 'setup-old', current: false };
		await flushSetups([old]);
		const app = fixture.componentInstance as unknown as Harness;
		for (const [status, message] of [
			[401, 'session has expired'],
			[500, 'could not be changed'],
		] as const) {
			app.makeCurrent();
			http
				.expectOne('/api/v1/cars/car-1/setups/setup-old/current')
				.flush('failed', { status, statusText: 'Failed' });
			expect(app.actionError()).toContain(message);
		}

		app.makeCurrent();
		const stale = http.expectOne('/api/v1/cars/car-1/setups/setup-old/current');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		stale.flush({ setup: { ...old, current: true } });
		expect(app.setups()).toEqual([]);
	});

	it('ignores stale preview errors and stale save errors', async () => {
		await flushSetups();
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		const pending = new Subject<SoDialedImportPreview>();
		importer.result = pending;
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		pending.error(new Error('late failure'));

		app.openAdd();
		app.formModel.set({ ...emptySetupForm(), name: 'New car setup' });
		app.save();
		const save = http.expectOne('/api/v1/cars/car-2/setups');
		fixture.componentRef.setInput('carId', 'car-3');
		fixture.detectChanges();
		await flushSetups([], 'car-3');
		save.flush('failed', { status: 500, statusText: 'Failed' });
		expect(app.formError()).toBe('');
	});

	it('maps generic preview errors and cancels without a draft', async () => {
		await flushSetups();
		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		importer.result = throwError(() => ({ status: 500 }));
		const app = fixture.componentInstance as unknown as Harness;
		app.updateImportUrl('https://sodialed.com/setup/unavailable');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'That source could not be read',
		);
		app.cancelImport();
		http.expectNone((request) => request.url.includes('/cancel'));
	});

	it('uses empty strings when imported identity fields are absent', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		const emitted: Array<{ name: string; make: string; model: string }> = [];
		fixture.componentInstance.createCarFromImport.subscribe((value) =>
			emitted.push(value),
		);
		app.importPreview.set({ ...preview, carIdentity: {} });
		app.requestCreateCar();
		expect(emitted).toEqual([{ name: 'Imported car', make: '', model: '' }]);
	});

	it('ignores stale copy success and stale current-selection errors', async () => {
		const old = { ...currentSetup, id: 'setup-old', current: false };
		await flushSetups([old]);
		const app = fixture.componentInstance as unknown as Harness;
		app.copy();
		const copy = http.expectOne('/api/v1/cars/car-1/setups/setup-old/copy');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		copy.flush({ setup: { ...old, id: 'copy' } });
		expect(app.setups()).toEqual([]);

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
		await flushSetups([old]);
		app.makeCurrent();
		const current = http.expectOne(
			'/api/v1/cars/car-1/setups/setup-old/current',
		);
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		await flushSetups([], 'car-2');
		current.flush('failed', { status: 500, statusText: 'Failed' });
		expect(app.actionError()).toBe('');
	});

	it('falls back to draft review data when edited JSON has no review buckets', async () => {
		await flushSetups();
		const app = fixture.componentInstance as unknown as Harness;
		app.importPreview.set(preview);
		app.importCarModel.set({ carId: '' });
		app.formModel.set({
			...emptySetupForm(),
			name: 'Imported fallback',
			unmappedValues: '{}',
			rawValues: '{}',
		});
		app.save();
		const update = http.expectOne('/api/v1/setup-imports/drafts/draft-1');
		expect(update.request.body).toMatchObject({
			carId: 'car-1',
			uncertainValues: preview.uncertainValues,
			unmappedValues: {},
		});
		update.flush('failed', { status: 500, statusText: 'Failed' });
	});

	it('executes every setup action through its rendered control', async () => {
		const historical = {
			...currentSetup,
			id: 'setup-old',
			name: 'Historical',
			current: false,
		};
		await flushSetups([currentSetup, historical]);
		const app = fixture.componentInstance as unknown as Harness;
		const byText = (label: string): HTMLButtonElement => {
			const button = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label && !candidate.disabled,
			);
			expect(button).toBeTruthy();
			return button as HTMLButtonElement;
		};

		byText('New setup').click();
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();

		app.action.set('copy');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Copying…');
		app.action.set(null);
		fixture.detectChanges();
		byText('Copy previous').click();
		http
			.expectOne('/api/v1/cars/car-1/setups/setup-1/copy')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		fixture.detectChanges();

		const oldRow = [
			...fixture.nativeElement.querySelectorAll('.setup-row'),
		].find((row: HTMLButtonElement) =>
			row.textContent?.includes('Historical'),
		) as HTMLButtonElement;
		oldRow.click();
		fixture.detectChanges();
		byText('Copy setup').click();
		http
			.expectOne('/api/v1/cars/car-1/setups/setup-old/copy')
			.flush('offline', { status: 500, statusText: 'Unavailable' });
		fixture.detectChanges();
		byText('Edit').click();
		fixture.detectChanges();
		byText('Cancel').click();
		fixture.detectChanges();

		app.action.set('current');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Selecting…');
		app.action.set(null);
		fixture.detectChanges();
		byText('Select as current').click();
		http
			.expectOne('/api/v1/cars/car-1/setups/setup-old/current')
			.flush('offline', { status: 500, statusText: 'Unavailable' });

		fixture.componentRef.setInput('availableCars', [
			{ id: 'car-1', name: 'Red', make: 'Associated', model: 'B6.4' },
			{ id: 'car-2', name: 'Blue' },
		]);
		app.updateImportUrl('https://sodialed.com/setup/abc');
		app.previewImport();
		fixture.detectChanges();
		byText('Create a car from this identity').click();
		app.action.set('save');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Saving…');
		app.action.set(null);
		fixture.detectChanges();
		byText('Cancel').click();
		http.expectOne('/api/v1/setup-imports/drafts/draft-1/cancel').flush(null);
	});

	it('renders loading import and all setup display fallbacks', async () => {
		const sections = {
			...currentSetup.sections,
			vehicle: { rideHeight: '', weight: '1500g' },
		};
		const partial = {
			...currentSetup,
			id: 'setup-partial',
			name: 'Partial',
			current: false,
			context: { track: '', condition: '', recordedAt: null },
			sections,
			source: {
				pdfUrl: 'https://example.test/raw.pdf',
				pdfTitle: null,
				pdfPage: null,
			},
			copiedFromSetupId: 'setup-source',
			unmappedValues: null,
			rawValues: null,
		};
		const bare = {
			...partial,
			id: 'setup-bare',
			name: 'Bare',
			source: null,
			copiedFromSetupId: null,
		};
		await flushSetups([currentSetup, partial, bare]);
		const app = fixture.componentInstance as unknown as Harness;
		const rows = fixture.nativeElement.querySelectorAll('.setup-row');
		(rows[1] as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Track not recorded');
		expect(fixture.nativeElement.textContent).toContain('Date not recorded');
		expect(fixture.nativeElement.textContent).toContain('Copied from');
		expect(fixture.nativeElement.textContent).toContain('1500g');
		(rows[2] as HTMLButtonElement).click();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.provenance')).toBeNull();
		expect(fixture.nativeElement.querySelector('.unmapped')).toBeNull();

		const importer = TestBed.inject(SoDialedImporterClient) as MockImporter;
		const pending = new Subject<SoDialedImportPreview>();
		importer.result = pending;
		app.updateImportUrl('https://sodialed.com/setup/pending');
		app.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Reading sheet…');
		pending.next({
			...preview,
			carIdentity: {},
			context: {},
			source: { ...preview.source, title: null },
		});
		pending.complete();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Unknown make');
		expect(fixture.nativeElement.textContent).toContain('vehicle identity');
		expect(fixture.nativeElement.textContent).toContain('Track not recorded');
	});

	it('renders archived empty setup history without a create action', async () => {
		fixture.componentRef.setInput('archived', true);
		await flushSetups([]);
		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
		expect(
			fixture.nativeElement.querySelector('.empty-state button'),
		).toBeNull();
	});

	it('renders a valid server form error and a title-only PDF reference', async () => {
		const titleOnly = {
			...currentSetup,
			id: 'title-only',
			current: false,
			source: {
				url: null,
				pdfUrl: null,
				pdfTitle: 'Title only',
				pdfPage: null,
			},
		};
		await flushSetups([titleOnly]);
		expect(fixture.nativeElement.textContent).toContain('Title only');
		const app = fixture.componentInstance as unknown as Harness;
		app.openAdd();
		app.formModel.set({ ...emptySetupForm(), name: 'Valid setup' });
		app.formError.set('The server rejected this setup.');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The server rejected this setup.',
		);
		expect(
			fixture.nativeElement.querySelector('#setup-form-validation ul'),
		).toBeNull();
	});
});
