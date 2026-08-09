import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarBuild } from './car-build';
import { CarBuildStore } from './car-build-store';
import { CarStore } from './car-store';

type TestSignal<T> = (() => T) & { set(value: T): void };

const testRoutes: Routes = [
	{
		path: 'garage/:carId/build',
		component: CarBuild,
		providers: [CarBuildStore, CarStore],
	},
];

describe('Car build', () => {
	let harness: RouterTestingHarness;

	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarBuild],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
				CarBuildStore,
				CarStore,
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		harness = await RouterTestingHarness.create();
	});

	afterEach(() => http.verify());

	const car = {
		id: 'car-1',
		name: 'Red Runner',
		make: 'Associated',
		model: 'B7',
		archivedAt: null,
	};

	it('stays idle until route input binding supplies a car', () => {
		const withoutInput = TestBed.createComponent(CarBuild);
		withoutInput.detectChanges();
		http.expectNone((request) => request.url.includes('/cars//'));
		withoutInput.destroy();
	});

	it('keeps protected car and build failures non-retryable', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			harness.routeNativeElement?.querySelector('[role="alert"] button'),
		).toBeNull();

		await harness.navigateByUrl('/garage/car-2/build');
		http
			.expectOne('/api/v1/cars/car-2')
			.flush({ car: { ...car, id: 'car-2' } });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-2/components')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			harness.routeNativeElement?.querySelector('[role="alert"] button'),
		).toBeNull();
	});

	it('resets build editor state when a reused route changes cars', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(): void;
			formError: TestSignal<string>;
			message: TestSignal<string>;
		};
		component.openAdd();
		component.formError.set('Old build error');
		component.message.set('Old build message');
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeTruthy();

		await harness.navigateByUrl('/garage/car-2/build');
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
		expect(harness.routeNativeElement?.textContent).not.toContain('Old build');
		http
			.expectOne('/api/v1/cars/car-2')
			.flush({ car: { ...car, id: 'car-2' } });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-2/components')
			.flush({ components: [] });
	});

	it('clears stale build feedback and identifies an expired save', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(): void;
			save(): void;
			form: TestSignal<{
				slotType: 'standard' | 'custom';
				slot: string;
				name: string;
				manufacturer: string;
				model: string;
				serialNumber: string;
				notes: string;
			}>;
			formError: TestSignal<string>;
			message: TestSignal<string>;
		};
		component.openAdd();
		component.form.set({
			slotType: 'standard',
			slot: 'motor',
			name: 'Race motor',
			manufacturer: '',
			model: '',
			serialNumber: '',
			notes: '',
		});
		component.formError.set('Old build error');
		component.message.set('Old build success');
		await harness.fixture.whenStable();
		component.save();
		harness.detectChanges();

		expect(harness.routeNativeElement?.textContent).not.toContain('Old build');
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Your garage session has expired',
		);
	});

	it('blocks build editor entry while a mutation is in flight', async () => {
		const installed = {
			id: 'component-1',
			carId: 'car-1',
			slot: 'motor',
			slotType: 'standard' as const,
			name: 'Race motor',
		};
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [installed] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			action: TestSignal<string | null>;
			openAdd(slot?: string): void;
			openEdit(value: typeof installed): void;
			openReplace(value: typeof installed): void;
		};
		component.action.set('edit');
		component.openAdd();
		component.openEdit(installed);
		component.openReplace(installed);
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
	});

	it('keeps an archived car readable while hiding build mutations', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({
			car: { ...car, archivedAt: '2026-08-07T00:00:00.000Z' },
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();

		expect(harness.routeNativeElement?.textContent).toContain(
			'changes are disabled until it is restored',
		);
		expect(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].some(
				(button) => button.textContent?.includes('Add'),
			),
		).toBe(false);
	});

	it('selects the newest installation and preserves a legacy custom slot', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({
				components: [
					{
						id: 'component-old',
						carId: 'car-1',
						slot: 'transponder-mount',
						slotType: null,
						name: 'Old mount',
						installedAt: '2026-01-01T00:00:00.000Z',
					},
					{
						id: 'component-new',
						carId: 'car-1',
						slot: 'transponder-mount',
						slotType: null,
						name: 'New mount',
						installedAt: '2026-02-01T00:00:00.000Z',
					},
				],
			});
		await harness.fixture.whenStable();
		harness.detectChanges();

		expect(harness.routeNativeElement?.textContent).toContain('New mount');
		expect(harness.routeNativeElement?.textContent).not.toContain('Old mount');
		const replace = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) => button.textContent?.trim() === 'Replace') as
			| HTMLButtonElement
			| undefined;
		replace?.click();
		harness.detectChanges();
		const customSlot = [
			...(harness.routeNativeElement?.querySelectorAll('label') ?? []),
		].find((label) => label.textContent?.includes('Custom slot'));
		expect(customSlot?.querySelector('input')).toBeTruthy();
	});

	it('recognizes the backend transmitter slot as standard', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({
				components: [
					{
						id: 'component-transmitter',
						carId: 'car-1',
						slot: 'transmitter',
						slotType: null,
						name: 'Track radio',
					},
				],
			});
		await harness.fixture.whenStable();
		harness.detectChanges();

		const replace = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) => button.textContent?.trim() === 'Replace') as
			| HTMLButtonElement
			| undefined;
		replace?.click();
		harness.detectChanges();
		const slot = [
			...(harness.routeNativeElement?.querySelectorAll('label') ?? []),
		].find((label) => label.textContent?.trim().startsWith('Slot'));
		const customSlot = [
			...(harness.routeNativeElement?.querySelectorAll('label') ?? []),
		].find((label) => label.textContent?.includes('Custom slot'));
		expect(slot?.querySelector('select')).toBeTruthy();
		expect(customSlot).toBeUndefined();
	});

	it('keeps the build editor open while a save is in flight', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].find(
				(button) => button.textContent?.includes('Add component'),
			) as HTMLButtonElement
		).click();
		harness.detectChanges();
		expect(
			harness.routeNativeElement
				?.querySelector('form')
				?.getAttribute('aria-describedby'),
		).toBe('component-form-intro');
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			action: TestSignal<string | null>;
			cancel(): void;
			save(): void;
		};
		component.action.set('save');
		harness.detectChanges();
		const cancel = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find(
			(button) => button.textContent?.trim() === 'Cancel',
		) as HTMLButtonElement;

		expect(cancel.disabled).toBe(true);
		component.cancel();
		component.save();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeTruthy();
		http.expectNone(
			(request) =>
				request.method !== 'GET' &&
				request.url === '/api/v1/cars/car-1/components',
		);
	});

	it('retries a failed build read and renders current and historical slots', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await Promise.resolve();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Reading the build sheet',
		);
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.url === '/api/v1/cars/car-1/components',
			);
		});
		refresh?.flush({
			components: [
				{
					id: 'motor-current',
					carId: 'car-1',
					slot: 'motor',
					name: 'Current motor',
					installedAt: 'not-a-date',
				},
				{
					id: 'motor-old',
					carId: 'car-1',
					slot: 'motor',
					name: 'Old motor',
					installedAt: '2026-01-01T00:00:00.000Z',
					removedAt: '2026-02-01T00:00:00.000Z',
				},
				{
					id: 'esc-old',
					carId: 'car-1',
					slot: 'esc',
					name: 'Old ESC',
					removedAt: '2026-02-01T00:00:00.000Z',
				},
			],
		});
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Manufacturer not recorded',
		);
		expect(harness.routeNativeElement?.textContent).toContain(
			'Previous installations (1)',
		);
		const buttons = (): HTMLButtonElement[] => [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		];
		buttons()
			.find((button) => button.textContent?.trim() === 'Add component')
			?.click();
		harness.detectChanges();
		buttons()
			.find((button) => button.textContent?.trim() === 'Cancel')
			?.click();
		harness.detectChanges();

		buttons()
			.find(
				(button) =>
					button.textContent?.trim() === 'Edit' &&
					button.closest('.form-actions') !== null,
			)
			?.click();
		harness.detectChanges();
		buttons()
			.find((button) => button.textContent?.trim() === 'Cancel')
			?.click();
		harness.detectChanges();

		buttons()
			.find(
				(button) =>
					button.textContent?.trim() === 'Replace' &&
					button.closest('.form-actions') !== null,
			)
			?.click();
		harness.detectChanges();
		buttons()
			.find((button) => button.textContent?.trim() === 'Cancel')
			?.click();
		harness.detectChanges();

		const install = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find(
			(button) => button.textContent?.trim() === 'Install',
		) as HTMLButtonElement;
		install.click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeTruthy();
		(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].find(
				(button) => button.textContent?.trim() === 'Cancel',
			) as HTMLButtonElement
		).click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
	});

	it('validates and completes add, edit, and replacement build mutations', async () => {
		const installed = {
			id: 'component-1',
			carId: 'car-1',
			slot: 'motor',
			slotType: 'standard' as const,
			name: 'Race motor',
			manufacturer: 'Hobbywing',
			model: 'G4',
			serialNumber: 'SN-1',
			notes: 'Fresh rotor',
		};
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].find(
				(button) => button.textContent?.includes('Add component'),
			) as HTMLButtonElement
		).click();
		harness.detectChanges();
		let form = harness.routeNativeElement?.querySelector(
			'form',
		) as HTMLFormElement;
		form.dispatchEvent(new Event('submit'));
		harness.detectChanges();
		expect(form.textContent).toContain('Name the component');

		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			form: TestSignal<{
				slotType: 'standard' | 'custom';
				slot: string;
				name: string;
				manufacturer: string;
				model: string;
				serialNumber: string;
				notes: string;
			}>;
		};
		component.form.set({
			slotType: 'custom',
			slot: '   ',
			name: 'Valid name',
			manufacturer: '',
			model: '',
			serialNumber: '',
			notes: '',
		});
		await harness.fixture.whenStable();
		form.dispatchEvent(new Event('submit'));
		harness.detectChanges();
		expect(form.textContent).toContain('Choose a component slot');
		component.form.set({
			slotType: 'custom',
			slot: ' transponder-mount ',
			name: ' New mount ',
			manufacturer: ' Brand ',
			model: ' Model ',
			serialNumber: ' Serial ',
			notes: ' Notes ',
		});
		await harness.fixture.whenStable();
		form.dispatchEvent(new Event('submit'));
		const create = http.expectOne('/api/v1/cars/car-1/components');
		expect(create.request.method).toBe('POST');
		expect(create.request.body).toEqual({
			slotType: 'custom',
			slot: 'transponder-mount',
			name: 'New mount',
			manufacturer: 'Brand',
			model: 'Model',
			serialNumber: 'Serial',
			notes: 'Notes',
		});
		create.flush({ component: installed });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.url === '/api/v1/cars/car-1/components',
			);
		});
		refresh?.flush({ components: [installed] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Build sheet saved',
		);

		const click = (label: string): void => {
			const button = [
				...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
			].find(
				(candidate) => candidate.textContent?.trim() === label,
			) as HTMLButtonElement;
			button.click();
			harness.detectChanges();
		};
		click('Edit');
		form = harness.routeNativeElement?.querySelector('form') as HTMLFormElement;
		component.form.set({ ...component.form(), name: 'Edited motor' });
		await harness.fixture.whenStable();
		form.dispatchEvent(new Event('submit'));
		const edit = http.expectOne('/api/v1/cars/car-1/components/component-1');
		expect(edit.request.method).toBe('PATCH');
		expect(edit.request.body).not.toHaveProperty('slot');
		edit.flush({ component: { ...installed, name: 'Edited motor' } });
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.url === '/api/v1/cars/car-1/components',
			);
		});
		refresh?.flush({ components: [{ ...installed, name: 'Edited motor' }] });
		await harness.fixture.whenStable();
		harness.detectChanges();

		click('Replace');
		form = harness.routeNativeElement?.querySelector('form') as HTMLFormElement;
		component.form.set({ ...component.form(), name: 'Replacement motor' });
		await harness.fixture.whenStable();
		form.dispatchEvent(new Event('submit'));
		const replace = http.expectOne(
			'/api/v1/cars/car-1/components/component-1/replace',
		);
		expect(replace.request.method).toBe('POST');
		replace.flush({ component: { ...installed, id: 'component-2' } });
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.url === '/api/v1/cars/car-1/components',
			);
		});
		refresh?.flush({ components: [{ ...installed, id: 'component-2' }] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'previous installation retained',
		);
	});

	it('retries the car record from Build and protects archived mutations', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(): void;
			save(): void;
			formError: TestSignal<string>;
		};
		component.save();
		expect(component.formError()).toContain('Restore this car');
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car-1');
		});
		refresh?.flush({
			car: { ...car, archivedAt: '2026-08-08T00:00:00.000Z' },
		});
		await harness.fixture.whenStable();
		harness.detectChanges();

		component.openAdd();
		component.save();
		expect(component.formError()).toContain('Restore this car');
	});

	it('covers build action-listener cancellation branches', async () => {
		const current = {
			id: 'component-current',
			carId: 'car-1',
			slot: 'motor',
			name: 'Current motor',
		};
		const removed = {
			id: 'component-removed',
			carId: 'car-1',
			slot: 'battery',
			name: 'Old battery',
			removedAt: '2026-08-01T00:00:00.000Z',
		};
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [current, removed] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const build = harness.routeDebugElement?.componentInstance as unknown as {
			openAdd(slot?: string): void;
			openEdit(value: typeof current): void;
			cancel(): void;
		};
		build.openAdd('motor');
		harness.detectChanges();
		expect(
			harness.routeNativeElement?.querySelector('#component-form-title')
				?.textContent,
		).toContain('Fit the replacement');
		build.cancel();
		build.openAdd('transponder-mount');
		build.cancel();
		harness.detectChanges();
		Object.defineProperties(build, {
			openAdd: { configurable: true, value: () => true },
			openEdit: { configurable: true, value: () => true },
		});
		for (const label of ['Install', 'Edit']) {
			const button = [
				...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
			].find(
				(candidate) => candidate.textContent?.trim() === label,
			) as HTMLButtonElement;
			expect(
				button.dispatchEvent(new MouseEvent('click', { cancelable: true })),
			).toBe(true);
		}

		await harness.navigateByUrl('/garage/car-2/build');
		http.expectOne('/api/v1/cars/car-2').flush({
			car: {
				...car,
				id: 'car-2',
				archivedAt: '2026-08-08T00:00:00.000Z',
			},
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-2/components')
			.flush({ components: [current, removed] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].some(
				(button) =>
					['Install', 'Edit'].includes(button.textContent?.trim() ?? ''),
			),
		).toBe(false);
	});

	it('covers remaining build validation, failures, and stale responses', async () => {
		await harness.navigateByUrl('/garage/car-1/build');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/components')
			.flush({ components: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(slot?: string): void;
			cancel(): void;
			save(): void;
			form: TestSignal<{
				slotType: 'standard' | 'custom';
				slot: string;
				name: string;
				manufacturer: string;
				model: string;
				serialNumber: string;
				notes: string;
			}>;
			formError: TestSignal<string>;
		};

		component.openAdd('battery');
		component.cancel();
		component.openAdd();
		component.form.set({ ...component.form(), name: '   ' });
		await harness.fixture.whenStable();
		component.save();
		expect(component.formError()).toContain(
			'Review the highlighted component fields',
		);

		component.form.set({ ...component.form(), name: 'Valid component' });
		await harness.fixture.whenStable();
		component.save();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush('archived', { status: 409, statusText: 'Conflict' });
		expect(component.formError()).toContain('Restore this car');
		component.save();
		http
			.expectOne('/api/v1/cars/car-1/components')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(component.formError()).toContain('could not be saved');

		component.save();
		const staleSuccess = http.expectOne('/api/v1/cars/car-1/components');
		await harness.navigateByUrl('/garage/car-2/build');
		http.expectOne('/api/v1/cars/car-2').flush({
			car: { ...car, id: 'car-2' },
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-2/components')
			.flush({ components: [] });
		staleSuccess.flush({ component: {} });

		component.openAdd();
		component.form.set({ ...component.form(), name: 'Car two component' });
		await harness.fixture.whenStable();
		component.save();
		const staleError = http.expectOne('/api/v1/cars/car-2/components');
		await harness.navigateByUrl('/garage/car-3/build');
		http.expectOne('/api/v1/cars/car-3').flush({
			car: { ...car, id: 'car-3' },
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-3/components')
			.flush({ components: [] });
		staleError.flush('offline', { status: 503, statusText: 'Unavailable' });
	});
});
