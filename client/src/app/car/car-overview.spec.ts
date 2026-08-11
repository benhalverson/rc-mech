import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import {
	provideRouter,
	type Routes,
	withComponentInputBinding,
} from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CarSyncMark } from '../garage/car-sync/car-sync.models';
import type { GarageCar, GarageCarInput } from '../garage/garage-store';
import type { VoiceOperationOutcome } from '../voice/voice.models';
import { VoiceLogStore } from '../voice/voice-log-store';
import type { CarUpdateOutcome } from './car.models';
import { CarOverview, carFormValidationMessage } from './car-overview';
import type { CarReadFailure } from './car-read-failure';
import { CarStore } from './car-store';
import { CurrentSetupStore } from './current-setup/current-setup-store';
import { DRIVE_SESSION_CONTEXT } from './drive-sessions/drive-session-context';

const idleUpdateOutcome = (): CarUpdateOutcome => ({
	status: 'idle',
	operationId: null,
});

class FakeCarStore {
	private readonly selectedCarId = signal<string | null>(null);
	readonly car = signal<GarageCar | null>(null);
	readonly loading = signal(false);
	readonly failure = signal<CarReadFailure | null>(null);
	readonly updateOutcome = signal<CarUpdateOutcome>(idleUpdateOutcome());
	readonly carAction = signal<'update' | null>(null);
	readonly carMutationError = signal('');
	readonly carMessage = signal('');
	readonly lifecycleAction = signal<'archive' | 'restore' | null>(null);
	readonly lifecycleError = signal('');
	readonly mutationsAvailable = signal(true);
	readonly syncMark = signal<CarSyncMark>({ kind: 'synced' });
	readonly syncFeedback = signal('');
	readonly selectCar = vi.fn((carId: string): void => {
		if (this.selectedCarId() === carId) return;
		this.selectedCarId.set(carId);
	});
	readonly retry = vi.fn((): void => undefined);
	readonly updateCar = vi.fn(
		(_input: Partial<GarageCarInput>): void => undefined,
	);
	readonly changeArchiveState = vi.fn(
		(_action: 'archive' | 'restore'): void => undefined,
	);
	readonly clearCarMutationState = vi.fn((): void => {
		this.updateOutcome.set(idleUpdateOutcome());
		this.carAction.set(null);
		this.carMutationError.set('');
		this.carMessage.set('');
	});
}

const emptyCurrentSetupStore = {
	current: () => null,
	loading: () => false,
	failure: () => null,
	priorityRows: () => [],
	remainingRows: () => [],
	changes: () => [],
	syncMark: () => ({ kind: 'synced' as const }),
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

const emptyVoiceStore = {
	localCaptures: signal([]),
	updates: signal([]),
	cars: signal([]),
	loading: signal(false),
	readError: signal(''),
	error: signal(''),
	message: signal(''),
	pending: signal(false),
	outcome: signal<VoiceOperationOutcome>({
		status: 'idle',
		operation: null,
		operationId: null,
	}),
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

const car = (overrides: Partial<GarageCar> = {}): GarageCar => ({
	id: 'car-1',
	name: 'Red Runner',
	make: 'Associated',
	model: 'B7',
	archivedAt: null,
	...overrides,
});

it('selects accessible car form validation feedback', () => {
	expect(carFormValidationMessage([{ message: 'Name the car.' }])).toBe(
		'Name the car.',
	);
	expect(carFormValidationMessage([{}])).toBe('Review the car details.');
	expect(carFormValidationMessage([])).toBe('Review the car details.');
});

describe('Car overview', () => {
	let harness: RouterTestingHarness;
	let store: FakeCarStore;

	beforeEach(async () => {
		store = new FakeCarStore();
		const routes: Routes = [
			{
				path: 'garage/:carId/overview',
				component: CarOverview,
				providers: [
					{ provide: CarStore, useValue: store },
					{ provide: CurrentSetupStore, useValue: emptyCurrentSetupStore },
					{ provide: VoiceLogStore, useValue: emptyVoiceStore },
					{
						provide: DRIVE_SESSION_CONTEXT,
						useValue: emptyDriveSessionContext,
					},
				],
			},
		];
		await TestBed.configureTestingModule({
			imports: [CarOverview],
			providers: [
				provideRouter(routes, withComponentInputBinding()),
				{ provide: CarStore, useValue: store },
				{ provide: CurrentSetupStore, useValue: emptyCurrentSetupStore },
				{ provide: VoiceLogStore, useValue: emptyVoiceStore },
				{
					provide: DRIVE_SESSION_CONTEXT,
					useValue: emptyDriveSessionContext,
				},
			],
		}).compileComponents();
		harness = await RouterTestingHarness.create();
	});

	afterEach(() => TestBed.resetTestingModule());

	const navigate = async (carId = 'car-1'): Promise<HTMLElement> => {
		await harness.navigateByUrl(`/garage/${carId}/overview`);
		harness.detectChanges();
		return harness.routeNativeElement as HTMLElement;
	};

	const root = (): HTMLElement => harness.routeNativeElement as HTMLElement;

	const button = (label: string): HTMLButtonElement => {
		const match = [...root().querySelectorAll('button')].find(
			(candidate) => candidate.textContent?.trim() === label,
		);
		if (!match) throw new Error(`Button not found: ${label}`);
		return match;
	};

	it('stays idle without route input and selects reused route context', async () => {
		const withoutInput = TestBed.createComponent(CarOverview);
		withoutInput.detectChanges();
		expect(store.selectCar).not.toHaveBeenCalled();
		withoutInput.destroy();

		store.car.set(car());
		await navigate();
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		button('Edit details').click();
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeTruthy();

		store.car.set(car({ id: 'car-2', name: 'Blue Runner' }));
		await navigate('car-2');
		expect(store.selectCar).toHaveBeenLastCalledWith('car-2');
		expect(store.clearCarMutationState).toHaveBeenCalled();
		expect(root().querySelector('.car-form')).toBeNull();
		expect(root().textContent).toContain('Blue Runner');
	});

	it('renders loading and retryable or terminal read failures', async () => {
		store.loading.set(true);
		const view = await navigate();
		expect(view.textContent).toContain('Opening the car overview');

		store.loading.set(false);
		store.failure.set({
			message: 'The car could not be loaded.',
			retryable: true,
		});
		harness.detectChanges();
		let alert = view.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('could not be loaded');
		button('Try again').click();
		expect(store.retry).toHaveBeenCalledOnce();

		store.failure.set({ message: 'Car not found.', retryable: false });
		harness.detectChanges();
		alert = view.querySelector('[role="alert"]');
		expect(alert?.textContent).toContain('Car not found');
		expect(alert?.querySelector('button')).toBeNull();
	});

	it('dispatches immutable edit commands and renders mutation state accessibly', async () => {
		store.car.set(
			car({
				make: null,
				manufacturer: 'Legacy Works',
				model: null,
				scale: null,
				vehicleType: null,
				powerType: null,
				notes: null,
			}),
		);
		const view = await navigate();
		expect(view.textContent).toContain('Legacy Works · Model not recorded');
		expect(view.textContent).toContain('No notes recorded yet');
		button('Edit details').click();
		harness.detectChanges();

		const form = view.querySelector('.car-form') as HTMLFormElement;
		const fields = form.querySelectorAll<
			HTMLInputElement | HTMLTextAreaElement
		>('input, textarea');
		for (const [field, value] of [...fields].map(
			(field, index) =>
				[
					field,
					[
						'  Red Runner Evo  ',
						'  Associated  ',
						'  B7.1  ',
						'  1/10  ',
						'  Buggy  ',
						'  Electric  ',
						'  Race car  ',
					][index],
				] as const,
		)) {
			field.value = value;
			field.dispatchEvent(new Event('input'));
		}
		form.dispatchEvent(new Event('submit'));
		expect(store.updateCar).toHaveBeenCalledWith({
			name: 'Red Runner Evo',
			make: 'Associated',
			model: 'B7.1',
			scale: '1/10',
			vehicleType: 'Buggy',
			powerType: 'Electric',
			notes: 'Race car',
		});

		store.carAction.set('update');
		harness.detectChanges();
		expect(view.textContent).toContain('Saving…');
		expect(button('Cancel').disabled).toBe(true);
		store.carAction.set(null);
		store.carMutationError.set('The car could not be saved.');
		harness.detectChanges();
		expect(form.getAttribute('aria-describedby')).toBe('car-form-error');
		expect(view.querySelector('[role="alert"]')?.textContent).toContain(
			'could not be saved',
		);
	});

	it('validates the local form, restores focus, and cancels editing', async () => {
		store.car.set(car());
		const view = await navigate();
		button('Edit details').click();
		harness.detectChanges();
		const form = view.querySelector('.car-form') as HTMLFormElement;
		const name = form.querySelector('input') as HTMLInputElement;
		name.value = '   ';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		harness.detectChanges();
		expect(view.textContent).toContain('Give this car a name before saving');
		expect(document.activeElement).toBe(name);
		expect(name.getAttribute('aria-describedby')).toBe('car-form-error');
		expect(store.updateCar).not.toHaveBeenCalled();
		button('Cancel').click();
		harness.detectChanges();
		expect(view.querySelector('.car-form')).toBeNull();
		expect(store.clearCarMutationState).toHaveBeenCalled();
	});

	it('submits only changed fields and closes an unchanged edit', async () => {
		store.car.set(car({ notes: 'Original note' }));
		const view = await navigate();
		button('Edit details').click();
		harness.detectChanges();
		const form = view.querySelector('.car-form') as HTMLFormElement;
		const name = form.querySelector('input') as HTMLInputElement;
		name.value = '  Red Runner Evo  ';
		name.dispatchEvent(new Event('input'));
		form.dispatchEvent(new Event('submit'));
		expect(store.updateCar).toHaveBeenCalledWith({ name: 'Red Runner Evo' });

		store.updateCar.mockClear();
		button('Cancel').click();
		harness.detectChanges();
		button('Edit details').click();
		harness.detectChanges();
		(view.querySelector('.car-form') as HTMLFormElement).dispatchEvent(
			new Event('submit'),
		);
		harness.detectChanges();
		expect(store.updateCar).not.toHaveBeenCalled();
		expect(view.querySelector('.car-form')).toBeNull();
	});

	it('reacts once to each successful update operation ID', async () => {
		store.car.set(car());
		await navigate();
		button('Edit details').click();
		harness.detectChanges();
		store.updateOutcome.set({ status: 'succeeded', operationId: 1 });
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeNull();

		button('Edit details').click();
		harness.detectChanges();
		store.updateOutcome.set({ status: 'succeeded', operationId: 1 });
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeTruthy();
		store.updateOutcome.set({
			status: 'failed',
			operationId: 2,
			error: { kind: 'unavailable' },
		});
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeTruthy();
		store.updateOutcome.set({ status: 'succeeded', operationId: 3 });
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeNull();
	});

	it('dispatches archive and restore intents and renders lifecycle status', async () => {
		store.car.set(car());
		const view = await navigate();
		button('Archive car').click();
		expect(store.changeArchiveState).toHaveBeenCalledWith('archive');
		store.lifecycleAction.set('archive');
		harness.detectChanges();
		expect(view.textContent).toContain('Archiving…');
		expect(button('Edit details').disabled).toBe(true);

		store.lifecycleAction.set(null);
		store.lifecycleError.set('The car could not be archived.');
		store.carMessage.set('Car details saved.');
		harness.detectChanges();
		expect(view.querySelector('[role="alert"]')?.textContent).toContain(
			'could not be archived',
		);
		expect(view.querySelector('[role="status"]')?.textContent).toContain(
			'Car details saved',
		);

		store.lifecycleError.set('');
		store.car.set(car({ archivedAt: '2026-08-08T00:00:00.000Z' }));
		harness.detectChanges();
		expect(view.textContent).toContain('Archived record');
		button('Restore car').click();
		expect(store.changeArchiveState).toHaveBeenLastCalledWith('restore');
		store.lifecycleAction.set('restore');
		harness.detectChanges();
		expect(view.textContent).toContain('Restoring…');
	});

	it('guards overlapping local actions at the component seam', async () => {
		store.car.set(car());
		await navigate();

		store.carAction.set('update');
		harness.detectChanges();
		button('Edit details').dispatchEvent(new MouseEvent('click'));
		expect(root().querySelector('.car-form')).toBeNull();
		store.carAction.set(null);
		store.lifecycleAction.set('archive');
		harness.detectChanges();
		button('Edit details').dispatchEvent(new MouseEvent('click'));
		expect(root().querySelector('.car-form')).toBeNull();
		store.lifecycleAction.set(null);
		store.car.set(car({ make: null, manufacturer: null, model: null }));
		harness.detectChanges();
		button('Edit details').click();
		harness.detectChanges();
		const form = root().querySelector('.car-form') as HTMLFormElement;
		expect(
			[...form.querySelectorAll<HTMLInputElement>('input')].map(
				(input) => input.value,
			),
		).toContain('');

		store.carAction.set('update');
		harness.detectChanges();
		button('Cancel').dispatchEvent(new MouseEvent('click'));
		form.dispatchEvent(new Event('submit'));
		expect(root().querySelector('.car-form')).toBeTruthy();
		expect(store.updateCar).not.toHaveBeenCalled();
		store.carAction.set(null);
		harness.detectChanges();
		button('Cancel').click();
		harness.detectChanges();
		expect(root().querySelector('.car-form')).toBeNull();
	});

	it('renders offline availability and each durable Car sync state', async () => {
		store.car.set(car());
		const view = await navigate();
		store.mutationsAvailable.set(false);
		store.syncMark.set({
			kind: 'pending',
			operationIds: ['operation-1'],
		});
		harness.detectChanges();
		expect(view.textContent).toContain('Car changes are unavailable');
		expect(view.textContent).toContain('Pending sync');
		expect(button('Edit details').disabled).toBe(true);

		store.syncMark.set({
			kind: 'syncing',
			operationIds: ['operation-1'],
		});
		harness.detectChanges();
		expect(view.textContent).toContain('Syncing');

		store.syncMark.set({
			kind: 'needs-attention',
			operationId: 'operation-1',
			feedback: { code: 'INVALID', message: 'Correct the Car name.' },
		});
		store.syncFeedback.set('Correct the Car name.');
		harness.detectChanges();
		expect(view.textContent).toContain('Needs attention');
		expect(view.textContent).toContain('Correct the Car name.');

		store.syncMark.set({
			kind: 'conflict',
			operationId: 'operation-1',
			remote: { id: 'car-1', name: 'Remote Runner', version: 2 },
		});
		harness.detectChanges();
		expect(view.textContent).toContain('Sync conflict');
	});
});
