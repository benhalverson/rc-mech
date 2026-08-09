import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import {
	provideRouter,
	Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarPhotoStore } from '../car-photo-store';
import { SetupSnapshotStore } from '../setup-snapshot-store';
import { CarBuild } from './car-build';
import { CarBuildStore } from './car-build-store';
import { CarOverview } from './car-overview';
import { CarPhotos } from './car-photos';
import { CarSetups } from './car-setups';
import { CarSetupsStore } from './car-setups-store';
import { CarStore } from './car-store';
import { CurrentSetupStore } from './current-setup/current-setup-store';
import { DriveSessionGateway } from './drive-sessions/drive-session-gateway';
import { DriveSessionStore } from './drive-sessions/drive-session-store';
import { DriveSessions } from './drive-sessions/drive-sessions';
import { DRIVE_SESSION_CONTEXT } from './drive-sessions/drive-session-context';
import { VoiceLogStore } from '../voice/voice-log-store';
import type { VoiceOperationOutcome } from '../voice/voice.models';

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
			CarStore,
			{ provide: CurrentSetupStore, useValue: emptyCurrentSetupStore },
			{ provide: VoiceLogStore, useValue: emptyVoiceStore },
			{ provide: DRIVE_SESSION_CONTEXT, useValue: emptyDriveSessionContext },
		],
	},
	{
		path: 'garage/:carId/build',
		component: CarBuild,
		providers: [CarBuildStore, CarStore],
	},
	{
		path: 'garage/:carId/setups',
		component: CarSetups,
		providers: [CarSetupsStore, CarStore, SetupSnapshotStore],
	},
	{
		path: 'garage/:carId/photos',
		component: CarPhotos,
		providers: [CarPhotoStore, CarStore],
	},
	{
		path: 'garage/:carId/drive-sessions',
		component: DriveSessions,
		providers: [DriveSessionGateway, DriveSessionStore, CarStore],
	},
];

describe('Car section routes', () => {
	let harness: RouterTestingHarness;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [CarBuild, CarOverview, CarPhotos, DriveSessions, CarSetups],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
				CarBuildStore,
				CarPhotoStore,
				DriveSessionGateway,
				DriveSessionStore,
				CarSetupsStore,
				CarStore,
				SetupSnapshotStore,
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

	const flush = (request: TestRequest): void => {
		const url = request.request.url;
		if (url === '/api/v1/cars/car-1') request.flush({ car });
		else if (url === '/api/v1/cars/car-1/components')
			request.flush({ components: [] });
		else if (url === '/api/v1/cars/car-1/setups') request.flush({ setups: [] });
		else if (url === '/api/v1/cars') request.flush({ cars: [car] });
		else if (url === '/api/v1/cars/car-1/photos') request.flush({ photos: [] });
		else if (url === '/api/v1/cars/car-1/drives')
			request.flush({ driveSessions: [] });
		else if (url === '/api/v1/preferences/timezone')
			request.flush({ timezone: 'UTC' });
		else throw new Error(`Unexpected Car section read: ${url}`);
	};

	it.each([
		{
			path: 'overview',
			urls: ['/api/v1/cars/car-1'],
			visible: 'Car overview',
		},
		{
			path: 'build',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars/car-1/components'],
			visible: 'No components recorded',
		},
		{
			path: 'setups',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars', '/api/v1/cars/car-1/setups'],
			visible: 'No setup snapshots yet',
		},
		{
			path: 'photos',
			urls: ['/api/v1/cars/car-1', '/api/v1/cars/car-1/photos'],
			visible: 'No photos yet',
		},
		{
			path: 'drive-sessions',
			urls: [
				'/api/v1/cars/car-1',
				'/api/v1/cars/car-1/drives',
				'/api/v1/preferences/timezone',
			],
			visible: 'No drive sessions recorded',
		},
	])(
		'deep-links to $path and requests only its section data',
		async ({ path, urls, visible }) => {
			await harness.navigateByUrl(`/garage/car-1/${path}`);
			const requests = http.match(() => true);
			for (const request of requests) flush(request);
			await Promise.resolve();
			harness.detectChanges();
			const nestedRequests: TestRequest[] = [];
			if (path === 'setups' || path === 'photos') {
				let nested: TestRequest | undefined;
				await vi.waitFor(() => {
					nested = http.expectOne(
						path === 'setups'
							? '/api/v1/cars/car-1/setups'
							: '/api/v1/cars/car-1/photos',
					);
				});
				if (nested) nestedRequests.push(nested);
			}
			for (const request of nestedRequests) flush(request);
			await harness.fixture.whenStable();
			harness.detectChanges();
			expect(
				[...requests, ...nestedRequests]
					.map((request) => request.request.url)
					.sort(),
			).toEqual([...urls].sort());

			expect(harness.routeNativeElement?.textContent).toContain(visible);
			expect(
				harness.routeNativeElement?.querySelector(
					'[data-route-focus][tabindex="-1"]',
				),
			).toBeTruthy();
			expect(
				harness.routeNativeElement
					?.querySelector(
						'nav[aria-label="Car detail sections"] a[aria-current="page"]',
					)
					?.textContent?.toLowerCase(),
			).toContain(path.replaceAll('-', ' '));
		},
	);

	it.each([
		{
			path: 'build',
			reads: [['/api/v1/cars/car-1/components', { components: [] }]] as const,
		},
		{
			path: 'photos',
			reads: [] as const,
		},
		{
			path: 'drive-sessions',
			reads: [
				['/api/v1/cars/car-1/drives', { driveSessions: [] }],
				['/api/v1/preferences/timezone', { timezone: 'UTC' }],
			] as const,
		},
		{
			path: 'setups',
			reads: [['/api/v1/cars', { cars: [car] }]] as const,
		},
	])(
		'hides retry for an expired car read from the $path leaf',
		async ({ path, reads }) => {
			await harness.navigateByUrl(`/garage/car-1/${path}`);
			http
				.expectOne('/api/v1/cars/car-1')
				.flush('expired', { status: 401, statusText: 'Unauthorized' });
			for (const [url, body] of reads)
				http.expectOne((request) => request.url === url).flush(body);
			await harness.fixture.whenStable();
			harness.detectChanges();
			const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
			expect(alert?.textContent).toContain('session has expired');
			expect(alert?.querySelector('button')).toBeNull();
		},
	);

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

	it.each([
		{
			path: 'build',
			endpoint: '/api/v1/cars/car-1/components',
		},
		{
			path: 'drive-sessions',
			endpoint: '/api/v1/cars/car-1/drives',
		},
	])(
		'explains an expired session on the $path read',
		async ({ path, endpoint }) => {
			await harness.navigateByUrl(`/garage/car-1/${path}`);
			http.expectOne('/api/v1/cars/car-1').flush({ car });
			http
				.expectOne((request) => request.url === endpoint)
				.flush('expired', { status: 401, statusText: 'Unauthorized' });
			if (path === 'drive-sessions')
				http
					.expectOne('/api/v1/preferences/timezone')
					.flush({ timezone: 'UTC' });
			await harness.fixture.whenStable();
			harness.detectChanges();

			const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
			expect(alert?.textContent).toContain('Your garage session has expired');
			expect(alert?.querySelector('button')).toBeNull();
		},
	);

	it('explains an expired session while preparing setup imports', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
		http.expectNone('/api/v1/cars/car-1/setups');
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

	it('resets setup creation state when a reused route changes cars', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let firstSetups: TestRequest | undefined;
		await vi.waitFor(() => {
			firstSetups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		firstSetups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createAction: TestSignal<boolean>;
			createError: TestSignal<string>;
		};
		component.createAction.set(true);
		component.createError.set('Old setup error');

		await harness.navigateByUrl('/garage/car-2/setups');
		harness.detectChanges();
		expect(component.createAction()).toBe(false);
		expect(component.createError()).toBe('');
		http
			.expectOne('/api/v1/cars/car-2')
			.flush({ car: { ...car, id: 'car-2' } });
		let nextSetups: TestRequest | undefined;
		await vi.waitFor(() => {
			nextSetups = http.expectOne('/api/v1/cars/car-2/setups');
		});
		nextSetups?.flush({ setups: [] });
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

	it('identifies an expired setup-import car creation', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: 'Imported car', make: '', model: '' });
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Your garage session has expired',
		);
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

	it.each([
		{
			path: 'build',
			endpoint: '/api/v1/cars/car%2Fone/components',
			body: { components: [] },
		},
		{
			path: 'drive-sessions',
			endpoint: '/api/v1/cars/car%2Fone/drives',
			body: { driveSessions: [] },
		},
	])(
		'encodes reserved characters for $path reads',
		async ({ path, endpoint, body }) => {
			await harness.navigateByUrl(`/garage/car%2Fone/${path}`);
			http.expectOne('/api/v1/cars/car%2Fone').flush({
				car: { ...car, id: 'car/one' },
			});
			http.expectOne((request) => request.url === endpoint).flush(body);
			if (path === 'drive-sessions')
				http
					.expectOne('/api/v1/preferences/timezone')
					.flush({ timezone: 'UTC' });
			await harness.fixture.whenStable();
			harness.detectChanges();
		},
	);

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
					changeArchiveState(action: 'archive' | 'restore'): Promise<void>;
				};
			}
		).store;
		const change = store.changeArchiveState('archive');
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
		await change;
		expect(store.lifecycleAction()).toBeNull();
		expect(store.lifecycleError()).toBe('');
	});

	it('serializes car creation from a reviewed setup import', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		const identity = {
			name: ' Imported buggy ',
			make: ' Associated ',
			model: ' ',
		};
		component.createCar(identity);
		component.createCar(identity);
		const creation = http.expectOne('/api/v1/cars');
		expect(creation.request.method).toBe('POST');
		expect(creation.request.body).toEqual({
			name: 'Imported buggy',
			make: 'Associated',
		});
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Creating the new car',
		);
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'The new car could not be created',
		);

		component.createCar(identity);
		http.expectOne('/api/v1/cars').flush({
			car: { ...car, id: 'car-2', name: 'Imported buggy' },
		});
		let collectionRefresh: TestRequest | undefined;
		let carRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			collectionRefresh = http.expectOne('/api/v1/cars');
			carRefresh = http.expectOne('/api/v1/cars/car-2');
		});
		collectionRefresh?.flush({
			cars: [car, { ...car, id: 'car-2', name: 'Imported buggy' }],
		});
		carRefresh?.flush({
			car: { ...car, id: 'car-2', name: 'Imported buggy' },
		});
		let setupRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			setupRefresh = http.expectOne('/api/v1/cars/car-2/setups');
		});
		setupRefresh?.flush({ setups: [] });
	});

	it.each([
		{
			path: 'build',
			endpoint: '/api/v1/cars/car%2Fone/components',
			body: { components: [] },
		},
		{
			path: 'drive-sessions',
			endpoint: '/api/v1/cars/car%2Fone/drives',
			body: { driveSessions: [] },
		},
	])(
		'encodes reserved characters for $path reads',
		async ({ path, endpoint, body }) => {
			await harness.navigateByUrl(`/garage/car%2Fone/${path}`);
			http.expectOne('/api/v1/cars/car%2Fone').flush({
				car: { ...car, id: 'car/one' },
			});
			http.expectOne((request) => request.url === endpoint).flush(body);
			if (path === 'drive-sessions')
				http
					.expectOne('/api/v1/preferences/timezone')
					.flush({ timezone: 'UTC' });
			await harness.fixture.whenStable();
			harness.detectChanges();
		},
	);

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
				updateCar(value: { name: string }): Promise<boolean>;
				changeArchiveState(action: 'archive' | 'restore'): Promise<void>;
			};
		};
		expect(await component.store.updateCar({ name: 'Blocked' })).toBe(false);
		await component.store.changeArchiveState('archive');
		const archive = http.expectOne('/api/v1/cars/car-1/archive');
		archive.flush({ status: true });
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
		http.expectOne('/api/v1/cars/car-1/restore').flush({ status: true });
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

	it('retries the car record from the Photos leaf before loading the gallery', async () => {
		await harness.navigateByUrl('/garage/car-1/photos');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let carRefresh: TestRequest | undefined;
		await vi.waitFor(() => {
			carRefresh = http.expectOne('/api/v1/cars/car-1');
		});
		carRefresh?.flush({ car });
		let photos: TestRequest | undefined;
		await vi.waitFor(() => {
			photos = http.expectOne('/api/v1/cars/car-1/photos');
		});
		photos?.flush({ photos: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('No photos yet');
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

	it('retries setup import lookups and handles the child create event', async () => {
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		await Promise.resolve();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Preparing setup imports',
		);
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const retry = harness.routeNativeElement?.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let collection: TestRequest | undefined;
		await vi.waitFor(() => {
			collection = http.expectOne('/api/v1/cars');
		});
		collection?.flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const snapshots = harness.routeDebugElement?.query(
			By.css('app-setup-snapshots'),
		);
		snapshots?.triggerEventHandler('createCarFromImport', {
			name: '',
			make: '',
			model: '',
		});
		const creation = http.expectOne('/api/v1/cars');
		expect(creation.request.body).toEqual({ name: 'Imported car' });
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'new car could not be created',
		);
	});

	it('keeps every car leaf idle until route input binding supplies a car', async () => {
		const fixtures = [
			TestBed.createComponent(CarOverview),
			TestBed.createComponent(CarBuild),
			TestBed.createComponent(CarPhotos),
			TestBed.createComponent(DriveSessions),
			TestBed.createComponent(CarSetups),
		];
		for (const fixture of fixtures) fixture.detectChanges();
		await vi.waitFor(() => {
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
			http.expectOne('/api/v1/cars').flush({ cars: [] });
		});
		http.expectNone((request) => request.url.includes('/cars//'));
		for (const fixture of fixtures) fixture.destroy();
	});

	it.each([
		{
			path: 'drive-sessions',
			preRetryReads: [
				['/api/v1/cars/car-1/drives', { driveSessions: [] }],
				['/api/v1/preferences/timezone', { timezone: 'UTC' }],
			] as const,
			postRetryReads: [] as const,
		},
		{
			path: 'setups',
			preRetryReads: [['/api/v1/cars', { cars: [car] }]] as const,
			postRetryReads: [['/api/v1/cars/car-1/setups', { setups: [] }]] as const,
		},
	])(
		'retries a failed car read from the $path leaf',
		async ({ path, preRetryReads, postRetryReads }) => {
			await harness.navigateByUrl(`/garage/car-1/${path}`);
			http
				.expectOne('/api/v1/cars/car-1')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
			for (const [url, body] of preRetryReads)
				http.expectOne((candidate) => candidate.url === url).flush(body);
			await harness.fixture.whenStable();
			harness.detectChanges();
			(
				harness.routeNativeElement?.querySelector(
					'[role="alert"] button',
				) as HTMLButtonElement
			).click();
			let retry: TestRequest | undefined;
			await vi.waitFor(() => {
				retry = http.expectOne('/api/v1/cars/car-1');
			});
			retry?.flush({ car });
			for (const [url, body] of postRetryReads) {
				let request: TestRequest | undefined;
				await vi.waitFor(() => {
					request = http.expectOne((candidate) => candidate.url === url);
				});
				request?.flush(body);
			}
		},
	);

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
			save(event: Event): Promise<void>;
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
				updateCar(value: { name: string }): Promise<boolean>;
			};
		};
		component.openEdit(carWithoutDetails);
		component.form.set({ ...component.form(), name: '   ' });
		await harness.fixture.whenStable();
		Object.defineProperty(component.carFields(), 'errorSummary', {
			configurable: true,
			value: () => [],
		});
		await component.save(new Event('submit'));
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Review the car details',
		);

		component.form.set({ ...component.form(), name: 'Updated car' });
		await harness.fixture.whenStable();
		const update = component.store.updateCar({ name: 'Updated car' });
		component.openEdit(carWithoutDetails);
		component.cancelEdit();
		await component.save(new Event('submit'));
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain('Saving…');
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		expect(await update).toBe(false);
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

	it.each([
		{
			path: 'build',
			reads: [['/api/v1/cars/car-1/components', { components: [] }]] as const,
		},
		{
			path: 'photos',
			reads: [] as const,
		},
		{
			path: 'drive-sessions',
			reads: [
				['/api/v1/cars/car-1/drives', { driveSessions: [] }],
				['/api/v1/preferences/timezone', { timezone: 'UTC' }],
			] as const,
		},
		{
			path: 'setups',
			reads: [['/api/v1/cars', { cars: [car] }]] as const,
		},
	])(
		'preserves browser propagation semantics for the $path retry listener',
		async ({ path, reads }) => {
			await harness.navigateByUrl(`/garage/car-1/${path}`);
			http
				.expectOne('/api/v1/cars/car-1')
				.flush('offline', { status: 503, statusText: 'Unavailable' });
			for (const [url, body] of reads)
				http.expectOne((request) => request.url === url).flush(body);
			await harness.fixture.whenStable();
			harness.detectChanges();
			const component = harness.routeDebugElement
				?.componentInstance as unknown as {
				carStore: { retry(): void };
			};
			Object.defineProperty(component.carStore, 'retry', {
				configurable: true,
				value: () => true,
			});
			const retry = harness.routeNativeElement?.querySelector(
				'[role="alert"] button',
			) as HTMLButtonElement;
			expect(
				retry.dispatchEvent(new MouseEvent('click', { cancelable: true })),
			).toBe(true);
		},
	);

	it('covers build and overview action-listener cancellation branches', async () => {
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

	it('serializes model-only setup cars and ignores stale creation responses', async () => {
		const open = async (carId: string): Promise<void> => {
			await harness.navigateByUrl(`/garage/${carId}/setups`);
			http.expectOne(`/api/v1/cars/${carId}`).flush({
				car: { ...car, id: carId },
			});
			let setups: TestRequest | undefined;
			await vi.waitFor(() => {
				setups = http.expectOne(`/api/v1/cars/${carId}/setups`);
			});
			setups?.flush({ setups: [] });
		};
		await harness.navigateByUrl('/garage/car-1/setups');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http.expectOne('/api/v1/cars').flush({ cars: [car] });
		let setups: TestRequest | undefined;
		await vi.waitFor(() => {
			setups = http.expectOne('/api/v1/cars/car-1/setups');
		});
		setups?.flush({ setups: [] });
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			createCar(identity: { name: string; make: string; model: string }): void;
		};
		component.createCar({ name: '', make: '', model: ' B7 ' });
		let creation = http.expectOne('/api/v1/cars');
		expect(creation.request.body).toEqual({ name: 'B7', model: 'B7' });
		await open('car-2');
		creation.flush({ car: { ...car, id: 'created-1' } });

		component.createCar({ name: 'Second', make: '', model: '' });
		creation = http.expectOne('/api/v1/cars');
		await open('car-3');
		creation.flush('offline', { status: 503, statusText: 'Unavailable' });
	});
});
