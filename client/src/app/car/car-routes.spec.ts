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
import { CarPhotoStore } from '../car-photo-store';
import { SetupSnapshotStore } from '../setup-snapshot-store';
import { CarBuild } from './car-build';
import { CarBuildStore } from './car-build-store';
import { CarOverview } from './car-overview';
import { CarPhotos } from './car-photos';
import { CarRuns } from './car-runs';
import { CarRunsStore } from './car-runs-store';
import { CarSetups } from './car-setups';
import { CarSetupsStore } from './car-setups-store';
import { CarStore } from './car-store';

type TestSignal<T> = (() => T) & { set(value: T): void };

const testRoutes: Routes = [
	{
		path: 'garage/:carId/overview',
		component: CarOverview,
		providers: [CarStore],
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
		path: 'garage/:carId/runs',
		component: CarRuns,
		providers: [CarRunsStore, CarStore],
	},
];

describe('Car section routes', () => {
	let harness: RouterTestingHarness;
	let http: HttpTestingController;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter(testRoutes, withComponentInputBinding()),
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
			path: 'runs',
			urls: [
				'/api/v1/cars/car-1',
				'/api/v1/cars/car-1/drives',
				'/api/v1/preferences/timezone',
			],
			visible: 'No drive sessions recorded',
		},
	])('deep-links to $path and requests only its section data', async ({
		path,
		urls,
		visible,
	}) => {
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
		).toContain(path);
	});

	it('shows a loading state and retries a failed car read', async () => {
		await harness.navigateByUrl('/garage/car-1/overview');
		expect(harness.routeNativeElement?.textContent).toContain(
			'Opening the car overview',
		);
		http
			.expectOne('/api/v1/cars/car-1')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await harness.fixture.whenStable();
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
			path: 'runs',
			endpoint: '/api/v1/cars/car-1/drives',
		},
	])('explains an expired session on the $path read', async ({
		path,
		endpoint,
	}) => {
		await harness.navigateByUrl(`/garage/car-1/${path}`);
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === endpoint)
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		if (path === 'runs')
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const alert = harness.routeNativeElement?.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Your garage session has expired');
		expect(alert?.querySelector('button')).toBeNull();
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

	it('resets run editor state when a reused route changes cars', async () => {
		await harness.navigateByUrl('/garage/car-1/runs');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/drives')
			.flush({ driveSessions: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(): void;
			formError: TestSignal<string>;
			message: TestSignal<string>;
		};
		component.openAdd();
		component.formError.set('Old run error');
		component.message.set('Old run message');
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeTruthy();

		await harness.navigateByUrl('/garage/car-2/runs');
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeNull();
		expect(harness.routeNativeElement?.textContent).not.toContain('Old run');
		http
			.expectOne('/api/v1/cars/car-2')
			.flush({ car: { ...car, id: 'car-2' } });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-2/drives')
			.flush({ driveSessions: [] });
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

	it('clears stale run feedback and identifies expired mutations', async () => {
		const drive = {
			id: 'drive-1',
			carId: 'car-1',
			startedAt: '2026-08-07T10:00:00.000Z',
		};
		await harness.navigateByUrl('/garage/car-1/runs');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/drives')
			.flush({ driveSessions: [drive] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			openAdd(): void;
			save(): void;
			archive(value: typeof drive): void;
			form: TestSignal<{
				startedAt: string;
				durationMinutes: string;
				conditions: string;
				notes: string;
			}>;
			formError: TestSignal<string>;
			message: TestSignal<string>;
		};
		component.openAdd();
		component.form.set({
			startedAt: '2026-08-07T10:00',
			durationMinutes: '15',
			conditions: '',
			notes: '',
		});
		component.formError.set('Old run error');
		component.message.set('Old run success');
		await harness.fixture.whenStable();
		component.save();
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).not.toContain('Old run');
		http
			.expectOne('/api/v1/cars/car-1/drives')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).toContain(
			'Your garage session has expired',
		);

		component.message.set('Old archive error');
		component.archive(drive);
		harness.detectChanges();
		expect(harness.routeNativeElement?.textContent).not.toContain(
			'Old archive error',
		);
		http
			.expectOne('/api/v1/cars/car-1/drives/drive-1')
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
			path: 'runs',
			endpoint: '/api/v1/cars/car%2Fone/drives',
			body: { driveSessions: [] },
		},
	])('encodes reserved characters for $path reads', async ({
		path,
		endpoint,
		body,
	}) => {
		await harness.navigateByUrl(`/garage/car%2Fone/${path}`);
		http.expectOne('/api/v1/cars/car%2Fone').flush({
			car: { ...car, id: 'car/one' },
		});
		http.expectOne((request) => request.url === endpoint).flush(body);
		if (path === 'runs')
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
	});

	it('encodes reserved identifiers for drive mutations', async () => {
		const session = {
			id: 'drive/one',
			carId: 'car/one',
			startedAt: '2026-08-07T00:00:00.000Z',
		};
		await harness.navigateByUrl('/garage/car%2Fone/runs');
		http.expectOne('/api/v1/cars/car%2Fone').flush({
			car: { ...car, id: 'car/one' },
		});
		http
			.expectOne((request) => request.url === '/api/v1/cars/car%2Fone/drives')
			.flush({ driveSessions: [session] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			archive(value: typeof session): void;
		};
		component.archive(session);
		const request = http.expectOne('/api/v1/cars/car%2Fone/drives/drive%2Fone');
		expect(request.request.method).toBe('DELETE');
		request.flush('offline', { status: 503, statusText: 'Unavailable' });
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
			path: 'runs',
			endpoint: '/api/v1/cars/car%2Fone/drives',
			body: { driveSessions: [] },
		},
	])('encodes reserved characters for $path reads', async ({
		path,
		endpoint,
		body,
	}) => {
		await harness.navigateByUrl(`/garage/car%2Fone/${path}`);
		http.expectOne('/api/v1/cars/car%2Fone').flush({
			car: { ...car, id: 'car/one' },
		});
		http.expectOne((request) => request.url === endpoint).flush(body);
		if (path === 'runs')
			http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
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
				(button) => button.textContent?.includes('Add the first component'),
			) as HTMLButtonElement
		).click();
		harness.detectChanges();
		expect(
			harness.routeNativeElement
				?.querySelector('form')
				?.getAttribute('aria-describedby'),
		).toBeNull();
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

	it('blocks run editor actions while a mutation is in flight', async () => {
		await harness.navigateByUrl('/garage/car-1/runs');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/drives')
			.flush({ driveSessions: [] });
		http.expectOne('/api/v1/preferences/timezone').flush({ timezone: 'UTC' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			action: TestSignal<string | null>;
			openAdd(): void;
			cancel(): void;
			save(): void;
		};
		component.action.set('archive:drive-1');
		component.openAdd();
		harness.detectChanges();
		expect(harness.routeNativeElement?.querySelector('form')).toBeFalsy();
		expect(
			(
				[
					...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
				].find((button) =>
					button.textContent?.includes('Record the first drive'),
				) as HTMLButtonElement
			).disabled,
		).toBe(true);

		component.action.set(null);
		component.openAdd();
		harness.detectChanges();
		const startedAt = harness.routeNativeElement?.querySelector(
			'input[type="datetime-local"]',
		) as HTMLInputElement;
		startedAt.value = '';
		startedAt.dispatchEvent(new Event('input'));
		harness.detectChanges();
		expect(
			harness.routeNativeElement
				?.querySelector('form')
				?.getAttribute('aria-describedby'),
		).toBeNull();
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
				request.method !== 'GET' && request.url === '/api/v1/cars/car-1/drives',
		);
	});

	it('normalizes a number input with an invalid stored timezone', async () => {
		await harness.navigateByUrl('/garage/car-1/runs');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/drives')
			.flush({ driveSessions: [] });
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush({ timezone: 'Not/A-Timezone' });
		await harness.fixture.whenStable();
		harness.detectChanges();
		const add = [
			...(harness.routeNativeElement?.querySelectorAll('button') ?? []),
		].find((button) =>
			button.textContent?.includes('Record the first drive'),
		) as HTMLButtonElement | undefined;
		add?.click();
		harness.detectChanges();
		const durationLabel = [
			...(harness.routeNativeElement?.querySelectorAll('label') ?? []),
		].find((label) => label.textContent?.includes('Duration'));
		const duration = durationLabel?.querySelector('input') as HTMLInputElement;
		duration.value = '30';
		duration.dispatchEvent(new Event('input', { bubbles: true }));
		harness.detectChanges();
		await harness.fixture.whenStable();
		harness.routeNativeElement
			?.querySelector('form')
			?.dispatchEvent(new Event('submit'));

		const mutation = http.expectOne('/api/v1/cars/car-1/drives');
		expect(mutation.request.method).toBe('POST');
		expect(mutation.request.body.durationMinutes).toBe(30);
		expect(mutation.request.body.startedAt).toMatch(/Z$/);
		mutation.flush({ driveSession: { id: 'drive-1' } });
		let refresh: TestRequest | undefined;
		await vi.waitFor(() => {
			refresh = http.expectOne(
				(request) => request.url === '/api/v1/cars/car-1/drives',
			);
		});
		refresh?.flush({ driveSessions: [] });
	});

	it('falls back to UTC before rendering a run with an invalid stored timezone', async () => {
		await harness.navigateByUrl('/garage/car-1/runs');
		http.expectOne('/api/v1/cars/car-1').flush({ car });
		http
			.expectOne((request) => request.url === '/api/v1/cars/car-1/drives')
			.flush({
				driveSessions: [
					{
						id: 'drive-1',
						carId: 'car-1',
						startedAt: '2026-08-07T12:00:00.000Z',
						durationMinutes: 10,
					},
				],
			});
		http
			.expectOne('/api/v1/preferences/timezone')
			.flush({ timezone: 'Not/A-Timezone' });
		await harness.fixture.whenStable();
		harness.detectChanges();

		const component = harness.routeDebugElement
			?.componentInstance as unknown as {
			runsStore: { timezone(): string };
		};
		expect(component.runsStore.timezone()).toBe('UTC');
		expect(harness.routeNativeElement?.textContent).toContain(
			'Conditions not recorded',
		);
		expect(
			harness.routeNativeElement?.querySelector('.session-row p'),
		).toBeNull();
	});
});
