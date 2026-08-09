import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VoiceOperationOutcome } from '../voice/voice.models';
import { VoiceLogStore } from '../voice/voice-log-store';
import { CarGateway } from './car-gateway';
import { CarOverview } from './car-overview';
import { CarStore } from './car-store';
import { CurrentSetupStore } from './current-setup/current-setup-store';
import { DRIVE_SESSION_CONTEXT } from './drive-sessions/drive-session-context';

type TestSignal<T> = (() => T) & { set(value: T): void };

const emptyCurrentSetupStore = {
	current: () => null,
	loading: () => false,
	failure: () => null,
	priorityRows: () => [],
	remainingRows: () => [],
	changes: () => [],
	timezone: () => 'UTC',
	timezoneReady: () => true,
	outcome: () => ({
		status: 'idle' as const,
		operation: 'save-current-setup' as const,
		operationId: null,
	}),
	pending: () => false,
	saveError: () => '',
	selectCar: (): void => undefined,
	clearSaveOutcome: (): void => undefined,
	saveCurrentSetup: (): void => undefined,
	retry: (): void => undefined,
};

const emptyVoiceOutcome = signal<VoiceOperationOutcome>({
	status: 'idle',
	operation: null,
	operationId: null,
});
const emptyVoiceStore = {
	localCaptures: signal([]),
	updates: signal([]),
	cars: signal([]),
	loading: signal(false),
	readError: signal(''),
	error: signal(''),
	message: signal(''),
	pending: signal(false),
	outcome: emptyVoiceOutcome,
	recorderError: signal(''),
	recordingMode: signal(null),
	checking: signal(false),
	supported: signal(true),
	starting: signal(false),
	recording: signal(false),
	elapsedSeconds: signal(0),
	inputLevel: signal(0),
	audioDetected: signal(false),
	inputMuted: signal(false),
	selectCar: (): void => undefined,
	retryQueued: (): void => undefined,
	detectRecorderSupport: (): void => undefined,
	startRecording: (): void => undefined,
	stopRecording: (): void => undefined,
	cancelRecording: (): void => undefined,
	captureText: (): void => undefined,
	correctText: (): void => undefined,
	updateContext: (): void => undefined,
	process: (): void => undefined,
	confirm: (): void => undefined,
	discardLocal: (): void => undefined,
	discardServer: (): void => undefined,
	retryRead: (): void => undefined,
};
const emptyDriveSessionContext = {
	sessions: signal([]),
	timezone: signal('UTC'),
	selectCar: (): void => undefined,
};

const testRoutes: Routes = [
	{
		path: 'garage/:carId/overview',
		component: CarOverview,
		providers: [
			CarGateway,
			CarStore,
			{ provide: CurrentSetupStore, useValue: emptyCurrentSetupStore },
			{ provide: VoiceLogStore, useValue: emptyVoiceStore },
			{ provide: DRIVE_SESSION_CONTEXT, useValue: emptyDriveSessionContext },
		],
	},
];

describe('Car overview', () => {
	let harness: RouterTestingHarness;

	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarOverview],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
				CarGateway,
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
		const withoutInput = TestBed.createComponent(CarOverview);
		withoutInput.detectChanges();
		http.expectNone((request) => request.url.includes('/cars//'));
		withoutInput.destroy();
	});

	it('shows a loading state and retries a failed car read', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		expect(harness.routeNativeElement?.textContent).toContain(
			'Opening the car overview',
		);
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await Promise.resolve();
		harness.detectChanges();
		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('could not be loaded');

		(alert?.querySelector('button') as HTMLButtonElement).click();
		let retry: TestRequest | undefined;
		await vi.waitFor(() => {
			retry = http.expectOne('/api/v1/cars/car-1');
		});
		retry?.flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Car overview');
	});

	it('edits car details and refreshes the overview resource', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const edit = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) => button.textContent?.trim() === 'Edit details') as
			| HTMLButtonElement
			| undefined;
		edit?.click();
		harness.detectChanges();
		const form = harness.routeNativeElement?.querySelector(
			'.car-form',
		) as HTMLFormElement;
		const name = form.querySelector('input') as HTMLInputElement;
		name.value = 'Red Runner Evo';
		name.dispatchEvent(new Event('input'));
		const make = [...form.querySelectorAll('label')]
			.find((label) => label.textContent?.trim().startsWith('Make'))
			?.querySelector('input') as HTMLInputElement;
		make.value = '';
		make.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));

		const mutation = http.expectOne('/api/v1/cars/car-1');
		expect(mutation.request.method).toBe('PATCH');
		expect(mutation.request.body).toMatchObject({
			name: 'Red Runner Evo',
			make: '',
			model: 'B7',
			scale: '',
			vehicleType: '',
			powerType: '',
			notes: '',
		});
		mutation.flush({ car: { ...car, name: 'Red Runner Evo' } });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car-1');
		});
		refresh?.flush({ car: { ...car, name: 'Red Runner Evo' } });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Car details saved.',
		);
	});

	it('closes an open editor when a reused overview route changes cars', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const edit = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) => button.textContent?.trim() === 'Edit details') as
			| HTMLButtonElement
			| undefined;
		edit?.click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('.car-form')).toBeTruthy();

		await harness.navigateByUrl('/garage/car-2/overview');
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('.car-form')).toBeNull();
		let nextCar: TestRequest | undefined;
		await vi.waitFor(() => {
			nextCar = http.expectOne('/api/v1/cars/car-2');
		});
		nextCar?.flush({ car: { ...car, id: 'car-2', name: 'Blue Runner' } });
	});

	it('identifies an expired session when archiving a car', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const archive = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) => button.textContent?.trim() === 'Archive car') as
			| HTMLButtonElement
			| undefined;
		archive?.click();
		http
			.expectOne('/api/v1/cars/car-1/archive')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		expect(
			harness.routeNativeElement?.querySelector('[role="alert"]')?.textContent,
		).toContain('Your garage session has expired');
	});

	it('shows missing-car guidance without a connection retry', async () => {
		await harness.navigateByUrl('/garage/missing/overview');
		http
			.expectOne('/api/v1/cars/missing')
			.flush('missing', { status: 404, statusText: 'Not Found' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Car not found');
		expect(alert?.textContent).not.toContain('Check the connection');
		expect(alert?.querySelector('button')).toBeNull();
	});

	it('explains an expired car read without offering retry', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
	});

	it('clears lifecycle state when selecting a different car', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const store = (
			harness.routeDebugElement?.componentInstance as unknown as {
				store: {
					lifecycleAction(): 'archive' | 'restore' | null;
					lifecycleError(): string;
					changeArchiveState(action: 'archive' | 'restore'): void;
				};
			}
		).store;
		store.changeArchiveState('archive');
		const mutation = http.expectOne('/api/v1/cars/car-1/archive');
		expect(store.lifecycleAction()).toBe('archive');

		await harness.navigateByUrl('/garage/car-2/overview');
		expect(store.lifecycleAction()).toBeNull();
		let nextCar: TestRequest | undefined;
		await vi.waitFor(() => {
			nextCar = http.expectOne('/api/v1/cars/car-2');
		});
		nextCar?.flush({ car: { ...car, id: 'car-2' } });
		mutation.flush('offline', { status: 503, statusText: 'Unavailable' });
		expect(store.lifecycleAction()).toBeNull();
		expect(store.lifecycleError()).toBe('');
	});

	it('validates overview edits and completes archive and restore lifecycles', async () => {
		const legacyCar = {
			...car,
			make: null,
			manufacturer: 'Legacy Works',
			model: null,
			scale: null,
			vehicleType: null,
			powerType: null,
			notes: null,
		};
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car: legacyCar });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Legacy Works · Model not recorded',
		);
		expect(harness.routeNativeElement?.textContent).toContain(
			'No notes recorded yet',
		);

		const button = (label: string): HTMLButtonElement =>
			[...(harness.routeNativeElement?.querySelectorAll('button') ?? [])].find(
				(candidate) => candidate.textContent?.trim() === label,
			) as HTMLButtonElement;
		button('Edit details').click();
		harness.detectChanges();
		let form = harness.routeNativeElement?.querySelector(
			'.car-form',
		) as HTMLFormElement;
		const name = form.querySelector('input') as HTMLInputElement;
		name.value = '   ';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Give this car a name before saving',
		);
		expect(document.activeElement).toBe(name);
		button('Cancel').click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('.car-form')).toBeNull();

		button('Archive car').click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Archiving…');
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			store: {
				updateCar(value: { name: string }): void;
				changeArchiveState(action: 'archive' | 'restore'): void;
			};
		};
		component.store.updateCar({ name: 'Blocked' });
		component.store.changeArchiveState('archive');
		const archive = http.expectOne('/api/v1/cars/car-1/archive');
		archive.flush({
			car: { ...legacyCar, archivedAt: '2026-08-08T00:00:00.000Z' },
		});
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car-1');
		});
		refresh?.flush({
			car: { ...legacyCar, archivedAt: '2026-08-08T00:00:00.000Z' },
		});
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Archived record',
		);

		button('Restore car').click();
		http
			.expectOne('/api/v1/cars/car-1/restore')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'could not be restored',
		);

		button('Restore car').click();
		http.expectOne('/api/v1/cars/car-1/restore').flush({ car: legacyCar });
		await vi.waitFor(() => {
			refresh = http.expectOne('/api/v1/cars/car-1');
		});
		refresh?.flush({ car: legacyCar });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Active car');

		button('Edit details').click();
		harness.detectChanges();
		form = harness.routeNativeElement?.querySelector(
			'.car-form',
		) as HTMLFormElement;
		const editedName = form.querySelector('input') as HTMLInputElement;
		editedName.value = 'Still legacy';
		editedName.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'could not be saved',
		);
		expect(harness.routeNativeElement?.querySelector('.car-form')).toBeTruthy();
	});

	it('covers guarded overview actions and validation fallback copy', async () => {
		const carWithoutDetails = {
			...car,
			make: null,
			manufacturer: null,
			model: null,
		};
		await harness.navigateByUrl('/garage/car-1/overview');
		http.expectOne('/api/v1/cars/car-1').flush({ car: carWithoutDetails });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Make not recorded · Model not recorded',
		);

		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openEdit(value: typeof carWithoutDetails): void;
			cancelEdit(): void;
			save(event: Event): void;
			form: TestSignal<{
				name: string;
				make: string;
				model: string;
				scale: string;
				vehicleType: string;
				powerType: string;
				notes: string;
			}>;
			carFields(): { errorSummary(): Array<{ message?: string }> };
			store: {
				updateCar(value: { name: string }): void;
			};
		};
		component.openEdit(carWithoutDetails);
		component.form.set({ ...component.form(), name: '   ' });
		await harness.fixture.whenStable();
		Object.defineProperty(component.carFields(), 'errorSummary', {
			configurable: true,
			value: () => [],
		});
		component.save(new Event('submit'));
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Review the car details',
		);

		component.form.set({ ...component.form(), name: 'Updated car' });
		await harness.fixture.whenStable();
		component.store.updateCar({ name: 'Updated car' });
		component.openEdit(carWithoutDetails);
		component.cancelEdit();
		component.save(new Event('submit'));
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Saving…');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		expect(component.store).toBeTruthy();
	});

	it('covers overview action-listener cancellation branches', async () => {
		await harness.navigateByUrl('/garage/car-3/overview');
		http
			.expectOne('/api/v1/cars/car-3')
			.flush({ car: { ...car, id: 'car-3' } });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const overview = harness.routeDebugElement
			?.componentInstance as unknown as { openEdit(value: typeof car): void };
		Object.defineProperty(overview, 'openEdit', {
			configurable: true,
			value: () => true,
		});
		const edit = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find(
			(button) => button.textContent?.trim() === 'Edit details',
		) as HTMLButtonElement;
		expect(
			edit.dispatchEvent(new MouseEvent('click', { cancelable: true })),
		).toBe(true);

		await harness.navigateByUrl('/garage/car-4/overview');
		http.expectOne('/api/v1/cars/car-4').flush({
			car: {
				...car,
				id: 'car-4',
				archivedAt: '2026-08-08T00:00:00.000Z',
			},
		});
		await harness.fixture.whenStable();
		harness.detectChanges();
		const restore = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find(
			(button) => button.textContent?.trim() === 'Restore car',
		) as HTMLButtonElement;
		restore.click();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Restoring…');
		http
			.expectOne('/api/v1/cars/car-4/restore')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
	});
});
