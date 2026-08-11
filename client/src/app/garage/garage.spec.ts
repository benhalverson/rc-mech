import { provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
	type TestRequest,
} from '@angular/common/http/testing';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineConnectivity } from '../offline/offline-connectivity';
import { OfflineWorkspaceStore } from '../offline/offline-workspace-store';
import type {
	CarSyncCommand,
	CarSyncMark,
	CarSyncOperation,
} from './car-sync/car-sync.models';
import {
	type CarWorkspaceMutationOutcome,
	CarWorkspaceStore,
} from './car-sync/car-workspace-store';
import { Garage } from './garage';
import type { GarageCar } from './garage.models';
import { GarageGateway } from './garage-gateway';
import { GarageStore } from './garage-store';

class FakeOfflineWorkspaceStore {
	readonly cars = signal<readonly GarageCar[]>([]);
	readonly hasSnapshot = signal(false);
	readonly status = signal('idle');
	readonly networkUnavailable = signal(false);
	readonly onlineOnlyReason = signal<
		'unsupported' | 'preparation-failed' | null
	>('unsupported');
	readonly setCars = vi.fn((cars: readonly GarageCar[]) => this.cars.set(cars));
	readonly markOffline = vi.fn(() => {
		this.networkUnavailable.set(true);
		if (this.status() === 'ready') this.status.set('offline');
		else if (this.status() === 'online-only')
			this.status.set('offline-unavailable');
	});
	readonly markOnline = vi.fn(() => {
		this.networkUnavailable.set(false);
		if (this.status() === 'offline') this.status.set('ready');
	});
}

class FakeOfflineConnectivity {
	readonly retryHint = signal(0);
	readonly scheduleRetry = vi.fn();
	readonly markRequestSucceeded = vi.fn();
}

class FakeCarWorkspaceStore {
	readonly opened = signal(false);
	readonly cars = signal<readonly GarageCar[]>([]);
	readonly operations = signal<readonly CarSyncOperation[]>([]);
	readonly mutationsAvailable = signal(true);
	readonly syncMark = signal<CarSyncMark>({ kind: 'synced' });
	readonly mutationOutcome = signal<CarWorkspaceMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly rowMark = signal<CarSyncMark>({ kind: 'synced' });
	private requestId = 0;
	readonly observeServerCars = vi.fn((cars: readonly GarageCar[]) => {
		this.cars.set(cars);
		this.opened.set(true);
	});
	readonly retrySync = vi.fn();
	readonly commit = vi.fn((command: CarSyncCommand) => {
		if (this.mutationOutcome().status === 'pending') return;
		this.mutationOutcome.set({
			status: 'pending',
			requestId: ++this.requestId,
			command,
		});
	});
	readonly clearMutationState = vi.fn(() => {
		if (this.mutationOutcome().status !== 'pending')
			this.mutationOutcome.set({ status: 'idle', requestId: null });
	});

	succeed(car: GarageCar, retainedLocally = false): void {
		const pending = this.mutationOutcome();
		if (pending.status !== 'pending') return;
		this.cars.set([...this.cars().filter((value) => value.id !== car.id), car]);
		this.mutationOutcome.set({
			...pending,
			status: 'succeeded',
			operationId: `operation-${pending.requestId}`,
			car,
			retainedLocally,
		});
	}

	fail(
		error: Extract<CarWorkspaceMutationOutcome, { status: 'failed' }>['error'],
	): void {
		const pending = this.mutationOutcome();
		if (pending.status !== 'pending') return;
		this.mutationOutcome.set({ ...pending, status: 'failed', error });
	}

	carMark(): CarSyncMark {
		return this.rowMark();
	}
}

describe('Garage', () => {
	let fixture: ComponentFixture<Garage>;
	let http: HttpTestingController;
	let offline: FakeOfflineWorkspaceStore;
	let connectivity: FakeOfflineConnectivity;
	let workspace: FakeCarWorkspaceStore;

	beforeEach(async () => {
		offline = new FakeOfflineWorkspaceStore();
		connectivity = new FakeOfflineConnectivity();
		workspace = new FakeCarWorkspaceStore();
		await TestBed.configureTestingModule({
			imports: [Garage],
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				provideRouter([]),
				GarageGateway,
				GarageStore,
				{ provide: OfflineConnectivity, useValue: connectivity },
				{ provide: OfflineWorkspaceStore, useValue: offline },
				{ provide: CarWorkspaceStore, useValue: workspace },
			],
		}).compileComponents();
		http = TestBed.inject(HttpTestingController);
		fixture = TestBed.createComponent(Garage);
		fixture.detectChanges();
	});

	afterEach(() => http.verify());

	it('renders a loading state and then the empty collection guidance', async () => {
		expect(TestBed.inject(GarageStore).collectionError()).toBe('');
		expect(fixture.nativeElement.textContent).toContain(
			'Opening the garage ledger',
		);
		http.expectOne('/api/v1/cars').flush(null);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The garage is waiting',
		);
	});

	it('creates the first car through an accessible Signal Form', async () => {
		vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const add = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Add a car',
		) as HTMLButtonElement;
		add.click();
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector(
			'.car-form',
		) as HTMLFormElement;
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const name = form.querySelector('input') as HTMLInputElement;
		expect(document.activeElement).toBe(name);
		name.value = '   ';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Give this car a name before saving',
		);
		const internal = fixture.componentInstance as unknown as {
			carFields(): { errorSummary(): Array<{ message?: string }> };
		};
		Object.defineProperty(internal.carFields(), 'errorSummary', {
			configurable: true,
			value: () => [],
		});
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Review the car details',
		);
		const inputs = [...form.querySelectorAll('input')];
		const oversizedValues = [
			'Valid name',
			'M'.repeat(121),
			'D'.repeat(121),
			'S'.repeat(21),
			'V'.repeat(81),
			'P'.repeat(81),
		];
		for (const [index, input] of inputs.entries()) {
			input.value = oversizedValues[index] ?? '';
			input.dispatchEvent(new Event('input'));
		}
		const notes = form.querySelector('textarea') as HTMLTextAreaElement;
		notes.value = 'N'.repeat(4001);
		notes.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		for (const id of [
			'car-make-error',
			'car-model-error',
			'car-scale-error',
			'car-vehicle-type-error',
			'car-power-type-error',
			'car-notes-error',
		])
			expect(form.querySelector(`#${id}`)).toBeTruthy();
		for (const input of inputs.slice(1)) {
			input.value = '';
			input.dispatchEvent(new Event('input'));
		}
		notes.value = '';
		notes.dispatchEvent(new Event('input'));

		name.value = 'Red Runner';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'create',
			input: { name: 'Red Runner' },
		});
		workspace.succeed({ id: 'car-1', name: 'Red Runner' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Car added to the garage.',
		);
	});

	it('renders a session-expired collection error with a retry action', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush('expired', { status: 401, statusText: 'Unauthorized' });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeTruthy();
		expect(fixture.nativeElement.textContent).toContain(
			'Your garage session has expired',
		);
		expect(offline.markOnline).toHaveBeenCalled();
		expect(connectivity.markRequestSucceeded).toHaveBeenCalled();
		expect(fixture.nativeElement.textContent).toContain('Try again');
		const retry = fixture.nativeElement.querySelector(
			'[role="alert"] button',
		) as HTMLButtonElement;
		retry.click();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne('/api/v1/cars');
		});
		request?.flush({ cars: [] });
	});

	it('renders accessible car links after collection loading', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
		await fixture.whenStable();
		workspace.opened.set(false);
		expect(TestBed.inject(GarageStore).cars()[0]?.name).toBe('Red Runner');
		workspace.opened.set(true);
		fixture.detectChanges();
		const link = fixture.nativeElement.querySelector(
			'a.car-row',
		) as HTMLAnchorElement;
		expect(link.textContent).toContain('Red Runner');
		expect(link.getAttribute('href')).toContain('/garage/car-1/overview');
		expect(
			fixture.nativeElement.querySelector('[data-route-focus][tabindex="-1"]'),
		).toBeTruthy();
	});

	it('reloads the collection when the archive filter changes', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.includes('Inspect archived cars'),
		) as HTMLButtonElement | undefined;
		toggle?.click();
		let request: TestRequest | undefined;
		await vi.waitFor(() => {
			request = http.expectOne(
				(candidate) =>
					candidate.url === '/api/v1/cars' &&
					candidate.params.get('archived') === 'all',
			);
		});
		request?.flush({ cars: [{ id: 'car-2', name: 'Retired buggy' }] });
	});

	it('renders a generic collection failure', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush('offline', { status: 503, statusText: 'Unavailable' });
		await fixture.whenStable();
		fixture.detectChanges();

		expect(fixture.nativeElement.textContent).toContain(
			'Check the connection and try again',
		);
	});

	it('blocks mutations after a confirmed outage without an offline snapshot', async () => {
		offline.status.set('online-only');
		http.expectOne('/api/v1/cars').error(new ProgressEvent('offline'));
		await fixture.whenStable();
		fixture.detectChanges();

		expect(offline.status()).toBe('offline-unavailable');
		expect(offline.networkUnavailable()).toBe(true);
		expect(connectivity.retryHint()).toBe(0);
		expect(connectivity.scheduleRetry).toHaveBeenCalled();
		workspace.mutationsAvailable.set(false);
		fixture.detectChanges();
		expect(TestBed.inject(GarageStore).carMutationsAvailable()).toBe(false);
		const add = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Add a car',
		) as HTMLButtonElement;
		expect(add.disabled).toBe(true);
	});

	it('reads the User-scoped Garage snapshot after the live collection fails', async () => {
		offline.cars.set([
			{ id: 'car-1', name: 'Offline buggy' },
			{
				id: 'car-2',
				name: 'Archived offline truck',
				archivedAt: '2026-08-01T00:00:00.000Z',
			},
		]);
		offline.hasSnapshot.set(true);
		offline.status.set('ready');
		expect(TestBed.inject(GarageStore).cars()).toEqual([
			{ id: 'car-1', name: 'Offline buggy' },
		]);
		workspace.cars.set(offline.cars());
		workspace.opened.set(true);
		http.expectOne('/api/v1/cars').error(new ProgressEvent('offline'));
		await fixture.whenStable();
		fixture.detectChanges();

		expect(offline.markOffline).toHaveBeenCalled();
		const add = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Add a car',
		) as HTMLButtonElement;
		expect(add.disabled).toBe(false);
		expect(fixture.nativeElement.textContent).toContain('Offline buggy');
		expect(fixture.nativeElement.textContent).not.toContain(
			'Archived offline truck',
		);
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();

		const toggle = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) =>
				button.textContent?.includes('Inspect archived cars'),
		) as HTMLButtonElement;
		toggle.click();
		await vi.waitFor(() =>
			http
				.expectOne((request) => request.params.get('archived') === 'all')
				.error(new ProgressEvent('offline')),
		);
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Archived offline truck',
		);

		connectivity.retryHint.update((value) => value + 1);
		let recovery: TestRequest | undefined;
		await vi.waitFor(() => {
			recovery = http.expectOne(
				(request) => request.params.get('archived') === 'all',
			);
		});
		recovery?.flush({ cars: [{ id: 'car-1', name: 'Recovered buggy' }] });
		await vi.waitFor(() => expect(offline.markOnline).toHaveBeenCalled());
		expect(connectivity.markRequestSucceeded).toHaveBeenCalled();
	});

	it('opens and cancels the toolbar create form', async () => {
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Red Runner' }] });
		await fixture.whenStable();
		fixture.detectChanges();
		const button = (label: string): HTMLButtonElement =>
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label,
			) as HTMLButtonElement;

		button('Add a car').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.car-form')).toBeTruthy();
		button('Cancel').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.car-form')).toBeNull();
	});

	it('submits normalized optional car fields and keeps failures editable', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		(
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(button: HTMLButtonElement) =>
					button.textContent?.trim() === 'Add a car',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		const form = fixture.nativeElement.querySelector(
			'.car-form',
		) as HTMLFormElement;
		const values = [
			' Red Runner ',
			' Associated ',
			' B7 ',
			' 1/10 ',
			' Buggy ',
			' Electric ',
		];
		for (const [index, input] of [
			...form.querySelectorAll('input'),
		].entries()) {
			input.value = values[index] ?? '';
			input.dispatchEvent(new Event('input'));
		}
		const notes = form.querySelector('textarea') as HTMLTextAreaElement;
		notes.value = ' Track car ';
		notes.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		expect(form.textContent).toContain('Adding…');
		const store = TestBed.inject(GarageStore);
		store.createCar({ input: { name: 'Blocked duplicate' } });
		const internal = fixture.componentInstance as unknown as {
			openCreate(): void;
			cancelEdit(): void;
		};
		internal.openCreate();
		internal.cancelEdit();
		form.dispatchEvent(new Event('submit'));
		expect(workspace.commit).toHaveBeenCalledWith({
			type: 'create',
			input: {
				name: 'Red Runner',
				make: 'Associated',
				model: 'B7',
				scale: '1/10',
				vehicleType: 'Buggy',
				powerType: 'Electric',
				notes: 'Track car',
			},
		});
		workspace.fail({ kind: 'http', status: 503 });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('could not be saved');
		expect(fixture.nativeElement.querySelector('.car-form')).toBeTruthy();

		form.dispatchEvent(new Event('submit'));
		workspace.fail({ kind: 'http', status: 401 });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('session has expired');
	});

	it('renders make and model fallbacks for mixed legacy car records', async () => {
		http.expectOne('/api/v1/cars').flush({
			cars: [
				{
					id: 'car-1',
					name: 'Modern',
					make: 'Associated',
					model: 'B7',
					scale: '1/10',
					vehicleType: 'Buggy',
					powerType: 'Electric',
					archivedAt: null,
				},
				{
					id: 'car-2',
					name: 'Legacy',
					manufacturer: 'Tamiya',
					scale: '1/12',
				},
				{ id: 'car-3', name: 'Unknown', vehicleType: 'Touring car' },
			],
		});
		await fixture.whenStable();
		fixture.detectChanges();
		const text = fixture.nativeElement.textContent;
		expect(text).toContain('Associated · B7');
		expect(text).toContain('Tamiya · Model not recorded');
		expect(text).toContain('Make not recorded · Model not recorded');
		expect(text).toContain('1/10');
		expect(text).toContain('Buggy');
		expect(text).toContain('Electric');
		expect(text).toContain('Active');
	});

	it('shows the archived empty state and toggles back to active cars', async () => {
		http.expectOne('/api/v1/cars').flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		const toggle = (): HTMLButtonElement =>
			[...fixture.nativeElement.querySelectorAll('button')].find(
				(button: HTMLButtonElement) =>
					button.textContent?.includes('archived cars') ||
					button.textContent?.includes('active cars'),
			) as HTMLButtonElement;
		toggle().click();
		let archived: TestRequest | undefined;
		await vi.waitFor(() => {
			archived = http.expectOne(
				(request) => request.params.get('archived') === 'all',
			);
		});
		archived?.flush({ cars: [] });
		await fixture.whenStable();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('No archived cars');

		toggle().click();
		let active: TestRequest | undefined;
		await vi.waitFor(() => {
			active = http.expectOne((request) => !request.params.has('archived'));
		});
		active?.flush({ cars: [] });
	});

	it('renders durable sync marks and exact local mutation feedback', async () => {
		vi.spyOn(TestBed.inject(Router), 'navigate').mockResolvedValue(true);
		expect(TestBed.inject(GarageStore).syncFeedback()).toBe('');
		http
			.expectOne('/api/v1/cars')
			.flush({ cars: [{ id: 'car-1', name: 'Local buggy', version: 1 }] });
		await fixture.whenStable();
		workspace.syncMark.set({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		workspace.rowMark.set({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Pending sync');

		workspace.syncMark.set({
			kind: 'syncing',
			operationIds: ['operation-1'],
		});
		workspace.rowMark.set({
			kind: 'syncing',
			operationIds: ['operation-1'],
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Syncing');

		workspace.syncMark.set({
			kind: 'needs-attention',
			operationId: 'operation-1',
			feedback: { code: 'INVALID', message: 'Correct the Car name.' },
		});
		workspace.rowMark.set(workspace.syncMark());
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Needs attention');
		expect(fixture.nativeElement.textContent).toContain(
			'Correct the Car name.',
		);

		workspace.syncMark.set({
			kind: 'conflict',
			operationId: 'operation-1',
			remote: { id: 'car-1', name: 'Remote buggy', version: 2 },
		});
		workspace.rowMark.set(workspace.syncMark());
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Sync conflict');
		workspace.operations.set([
			{
				operationId: 'operation-1',
				ownerKey: 'owner-1',
				carId: 'car-1',
				command: {
					type: 'car.create',
					carId: 'car-1',
					car: { name: 'Local buggy' },
				},
				dependencies: [],
				status: 'pending',
				createdAt: '2026-08-11T12:00:00.000Z',
			},
		]);
		workspace.mutationOutcome.set({
			status: 'succeeded',
			requestId: 1,
			operationId: 'operation-1',
			command: { type: 'create', input: { name: 'Local buggy' } },
			car: { id: 'car-1', name: 'Local buggy', version: 0 },
			retainedLocally: true,
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('saved locally');

		workspace.mutationOutcome.set({
			status: 'failed',
			requestId: 2,
			command: { type: 'create', input: { name: 'Rejected' } },
			error: { kind: 'local', message: 'IndexedDB is full.' },
		});
		expect(TestBed.inject(GarageStore).carMutationError()).toBe(
			'IndexedDB is full.',
		);
		workspace.mutationOutcome.set({
			status: 'failed',
			requestId: 3,
			command: { type: 'create', input: { name: 'Rejected' } },
			error: {
				kind: 'needs-attention',
				feedback: { code: 'INVALID', message: 'Use another name.' },
			},
		});
		expect(TestBed.inject(GarageStore).carMutationError()).toBe(
			'Use another name.',
		);

		workspace.mutationsAvailable.set(false);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Car changes are unavailable',
		);
	});
});
