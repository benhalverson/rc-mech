import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideNoopAnimations } from '@angular/platform-browser/animations';
import { SetupSnapshots } from './setup-snapshots';

type Harness = {
	form: { set(value: unknown): void };
	openAdd(): void;
	makeCurrent(): void;
	copy(): void;
};

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
		(
			fixture.nativeElement.querySelector('form') as HTMLFormElement
		).dispatchEvent(new Event('submit'));
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
});
