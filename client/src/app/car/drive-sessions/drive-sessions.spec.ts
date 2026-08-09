import { computed, signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CarStore } from '../car-store';
import type {
	ArchiveDriveSessionCommand,
	DriveSession,
	DriveSessionOutcome,
	SaveDriveSessionCommand,
} from './drive-session.models';
import { DriveSessionStore } from './drive-session-store';
import { DriveSessions } from './drive-sessions';

const driveSession = (overrides: Partial<DriveSession> = {}): DriveSession => ({
	id: 'drive-1',
	carId: 'car-1',
	startedAt: '2026-08-08T01:00:00.000Z',
	durationMinutes: 20,
	conditions: 'Dry',
	notes: 'Fast',
	deletedAt: null,
	...overrides,
});

class FakeCarStore {
	readonly loading = signal(false);
	readonly failure = signal<{ message: string; retryable: boolean } | null>(
		null,
	);
	readonly car = signal<{
		id: string;
		name: string;
		make: string;
		model: string;
		archivedAt: string | null;
	} | null>({
		id: 'car-1',
		name: 'Buggy',
		make: 'Associated',
		model: 'B7',
		archivedAt: null,
	});
	readonly selectCar = vi.fn();
	readonly retry = vi.fn();
}

class FakeDriveSessionStore {
	readonly sessions = signal<readonly DriveSession[]>([]);
	readonly timezone = signal('UTC');
	readonly loading = signal(false);
	readonly failure = signal<{ message: string; retryable: boolean } | null>(
		null,
	);
	readonly outcome = signal<DriveSessionOutcome>({
		status: 'idle',
		operation: null,
		operationId: null,
	});
	readonly pending = computed(() => this.outcome().status === 'pending');
	readonly error = signal('');
	readonly activeCount = computed(
		() => this.sessions().filter((session) => !session.deletedAt).length,
	);
	readonly selectCar = vi.fn();
	readonly retry = vi.fn();
	readonly saveDriveSession = vi.fn(
		(_command: SaveDriveSessionCommand): void => undefined,
	);
	readonly archiveDriveSession = vi.fn(
		(_command: ArchiveDriveSessionCommand): void => undefined,
	);
}

describe('DriveSessions', () => {
	let fixture: ComponentFixture<DriveSessions>;
	let carStore: FakeCarStore;
	let store: FakeDriveSessionStore;

	beforeEach(async () => {
		carStore = new FakeCarStore();
		store = new FakeDriveSessionStore();
		await TestBed.configureTestingModule({
			imports: [DriveSessions],
			providers: [
				provideRouter([]),
				{ provide: CarStore, useValue: carStore },
				{ provide: DriveSessionStore, useValue: store },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(DriveSessions);
		fixture.componentRef.setInput('carId', 'car-1');
	});

	afterEach(() => TestBed.resetTestingModule());

	const detect = (): HTMLElement => {
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	const button = (label: string): HTMLButtonElement => {
		const match = [
			...(fixture.nativeElement as HTMLElement).querySelectorAll('button'),
		].find((candidate) => candidate.textContent?.includes(label));
		if (!match) throw new Error(`Button not found: ${label}`);
		return match;
	};

	it('selects route context and renders loading and failure states', () => {
		carStore.loading.set(true);
		let root = detect();
		expect(root.textContent).toContain('Loading the selected car record');
		carStore.loading.set(false);
		carStore.failure.set({ message: 'Car failed.', retryable: true });
		root = detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'Car failed',
		);
		button('Try again').click();
		expect(carStore.retry).toHaveBeenCalledOnce();
		carStore.failure.set({ message: 'Expired car.', retryable: false });
		root = detect();
		expect(root.querySelector('[role="alert"] button')).toBeNull();
		carStore.failure.set(null);
		root = detect();
		expect(carStore.selectCar).toHaveBeenCalledWith('car-1');
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		expect(root.textContent).toContain('No drive sessions recorded');

		store.loading.set(true);
		root = detect();
		expect(root.textContent).toContain('Opening drive sessions');
		store.loading.set(false);
		store.failure.set({ message: 'History failed.', retryable: true });
		root = detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'History failed',
		);
		button('Try again').click();
		expect(store.retry).toHaveBeenCalledOnce();

		store.failure.set({ message: 'Expired.', retryable: false });
		root = detect();
		expect(root.querySelector('[role="alert"] button')).toBeNull();
	});

	it('stays idle until route input binding supplies a car', () => {
		carStore.selectCar.mockClear();
		store.selectCar.mockClear();
		const withoutInput = TestBed.createComponent(DriveSessions);
		withoutInput.detectChanges();
		expect(carStore.selectCar).not.toHaveBeenCalledWith('');
		expect(store.selectCar).not.toHaveBeenCalledWith('');
		withoutInput.destroy();
	});

	it('resets local editor state when the reused route selects another car', () => {
		const root = detect();
		button('Record the first drive session').click();
		detect();
		expect(document.activeElement).toBe(
			root.querySelector('#drive-session-form-title'),
		);
		const component = fixture.componentInstance as unknown as {
			formError: { set(value: string): void };
			message: { set(value: string): void };
		};
		component.formError.set('Old drive session error');
		component.message.set('Old drive session message');
		detect();
		expect(root.querySelector('form')).toBeTruthy();

		fixture.componentRef.setInput('carId', 'car-2');
		detect();
		expect(root.querySelector('form')).toBeNull();
		expect(root.textContent).not.toContain('Old drive session');
		expect(carStore.selectCar).toHaveBeenLastCalledWith('car-2');
		expect(store.selectCar).toHaveBeenLastCalledWith('car-2');
	});

	it('validates and focuses local Signal Form fields', () => {
		const root = detect();
		button('Record the first drive session').click();
		detect();
		const startedAt = root.querySelector(
			'input[type="datetime-local"]',
		) as HTMLInputElement;
		const duration = root.querySelector(
			'input[inputmode="numeric"]',
		) as HTMLInputElement;
		startedAt.value = '';
		startedAt.dispatchEvent(new Event('input'));
		duration.value = '2000';
		duration.dispatchEvent(new Event('input'));
		(root.querySelector('form') as HTMLFormElement).dispatchEvent(
			new Event('submit'),
		);
		detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'Review the highlighted drive session fields',
		);
		expect(
			root.querySelector('#drive-session-started-error')?.textContent,
		).toContain('Add when this drive session started');
		expect(startedAt.getAttribute('aria-describedby')).toBe(
			'drive-session-started-error',
		);
		expect(document.activeElement).toBe(startedAt);
		expect(store.saveDriveSession).not.toHaveBeenCalled();

		startedAt.value = '2026-08-08T01:00';
		startedAt.dispatchEvent(new Event('input'));
		(root.querySelector('form') as HTMLFormElement).dispatchEvent(
			new Event('submit'),
		);
		detect();
		expect(document.activeElement).toBe(duration);
		expect(
			root.querySelector('#drive-session-duration-error')?.textContent,
		).toContain('Duration must be between 1 and 1,440 minutes');
		expect(duration.getAttribute('aria-describedby')).toBe(
			'drive-session-duration-error',
		);
	});

	it('dispatches one immutable save command and reacts to typed outcomes', () => {
		const root = detect();
		button('Record the first drive session').click();
		detect();
		const duration = root.querySelector(
			'input[inputmode="numeric"]',
		) as HTMLInputElement;
		duration.value = '30';
		duration.dispatchEvent(new Event('input'));
		(root.querySelector('form') as HTMLFormElement).dispatchEvent(
			new Event('submit'),
		);
		expect(store.saveDriveSession).toHaveBeenCalledOnce();
		expect(store.saveDriveSession).toHaveBeenCalledWith({
			carId: 'car-1',
			sessionId: null,
			draft: expect.objectContaining({
				durationMinutes: 30,
				conditions: '',
				notes: '',
			}),
		});

		store.outcome.set({
			status: 'pending',
			operation: 'save-drive-session',
			operationId: 1,
		});
		detect();
		expect(button('Saving…').disabled).toBe(true);
		store.outcome.set({
			status: 'succeeded',
			operation: 'save-drive-session',
			operationId: 1,
			session: driveSession(),
		});
		detect();
		expect(root.querySelector('form')).toBeNull();
		expect(root.textContent).toContain('Drive session recorded');
		expect(document.activeElement).toBe(
			root.querySelector('#drive-sessions-title'),
		);
	});

	it('renders save and archive failures from store outcomes', () => {
		const root = detect();
		button('Record the first drive session').click();
		detect();
		store.error.set('The drive session could not be saved.');
		store.outcome.set({
			status: 'failed',
			operation: 'save-drive-session',
			operationId: 1,
			error: { kind: 'unavailable' },
		});
		detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'could not be saved',
		);

		store.error.set('The drive session could not be archived.');
		store.outcome.set({
			status: 'failed',
			operation: 'archive-drive-session',
			operationId: 2,
			error: { kind: 'unavailable' },
		});
		detect();
		expect(
			[...root.querySelectorAll('[role="alert"]')].some((alert) =>
				alert.textContent?.includes('could not be archived'),
			),
		).toBe(true);
	});

	it('dispatches archive intent and keeps archived cars read-only', () => {
		store.sessions.set([driveSession()]);
		let root = detect();
		button('Archive').click();
		expect(store.archiveDriveSession).toHaveBeenCalledWith({
			carId: 'car-1',
			sessionId: 'drive-1',
		});
		store.outcome.set({
			status: 'pending',
			operation: 'archive-drive-session',
			operationId: 1,
		});
		root = detect();
		expect(root.textContent).toContain('Archiving the drive session');
		store.outcome.set({
			status: 'succeeded',
			operation: 'archive-drive-session',
			operationId: 1,
			session: driveSession({ deletedAt: 'now' }),
		});
		store.sessions.set([driveSession({ deletedAt: 'now' })]);
		root = detect();
		expect(root.textContent).toContain('Archived drive session');

		carStore.car.update((car) => (car ? { ...car, archivedAt: 'now' } : car));
		root = detect();
		expect(root.textContent).not.toContain('Record a drive session');
		expect(
			root.querySelector('.session-row .drive-session-actions'),
		).toBeNull();
		store.sessions.set([driveSession({ durationMinutes: null })]);
		root = detect();
		expect(root.querySelector('.session-row span')).toBeNull();
		store.sessions.set([]);
		root = detect();
		expect(root.textContent).toContain('No drive sessions recorded');
		expect(root.querySelector('.alloy-empty-state button')).toBeNull();
	});

	it('edits, clears, cancels, and completes an existing drive session', () => {
		store.sessions.set([
			driveSession({
				conditions: null,
				notes: null,
			}),
		]);
		const root = detect();
		button('Record a drive session').click();
		detect();
		expect(document.activeElement).toBe(
			root.querySelector('#drive-session-form-title'),
		);
		button('Cancel').click();
		detect();
		expect(document.activeElement).toBe(button('Record a drive session'));
		button('Edit').click();
		detect();
		expect(document.activeElement).toBe(
			root.querySelector('#drive-session-form-title'),
		);
		expect(
			root.querySelector('#drive-session-form-title')?.textContent,
		).toContain('Edit drive session');
		expect(
			(root.querySelector('input[inputmode="numeric"]') as HTMLInputElement)
				.value,
		).toBe('20');
		const duration = root.querySelector(
			'input[inputmode="numeric"]',
		) as HTMLInputElement;
		duration.value = '';
		duration.dispatchEvent(new Event('input'));
		(root.querySelector('form') as HTMLFormElement).dispatchEvent(
			new Event('submit'),
		);
		expect(store.saveDriveSession).toHaveBeenCalledWith({
			carId: 'car-1',
			sessionId: 'drive-1',
			draft: expect.objectContaining({
				durationMinutes: null,
				conditions: '',
				notes: '',
			}),
		});

		store.outcome.set({
			status: 'succeeded',
			operation: 'save-drive-session',
			operationId: 1,
			session: driveSession(),
		});
		detect();
		expect(root.textContent).toContain('Drive session updated');
		expect(document.activeElement).toBe(
			root.querySelector('#drive-sessions-title'),
		);

		button('Edit').click();
		detect();
		button('Cancel').click();
		detect();
		expect(root.querySelector('form')).toBeNull();
		expect(document.activeElement).toBe(button('Edit drive session'));

		const component = fixture.componentInstance as unknown as {
			openEdit(session: DriveSession): void;
			cancel(): void;
		};
		component.openEdit(driveSession({ durationMinutes: null }));
		detect();
		expect(
			(root.querySelector('input[inputmode="numeric"]') as HTMLInputElement)
				.value,
		).toBe('');
		component.cancel();
	});

	it('guards editor and save actions while pending, missing, or archived', () => {
		const component = fixture.componentInstance as unknown as {
			openAdd(): void;
			openEdit(session: DriveSession): void;
			cancel(): void;
			save(): void;
			archive(session: DriveSession): void;
			formError(): string;
		};
		detect();
		carStore.car.set(null);
		component.save();
		expect(component.formError()).toContain('Restore this car');
		carStore.car.set({
			id: 'car-1',
			name: 'Buggy',
			make: 'Associated',
			model: 'B7',
			archivedAt: null,
		});
		component.openAdd();
		detect();
		store.outcome.set({
			status: 'pending',
			operation: 'save-drive-session',
			operationId: 1,
		});
		component.openAdd();
		component.openEdit(driveSession());
		component.cancel();
		component.save();
		component.archive(driveSession());
		expect(
			(fixture.nativeElement as HTMLElement).querySelector('form'),
		).toBeTruthy();

		store.outcome.set({ status: 'idle', operation: null, operationId: null });
		component.cancel();
		carStore.car.update((car) => (car ? { ...car, archivedAt: 'now' } : car));
		component.openAdd();
		component.openEdit(driveSession());
		component.archive(driveSession());
		carStore.car.update((car) => (car ? { ...car, archivedAt: null } : car));
		component.openEdit(driveSession({ deletedAt: 'now' }));
		carStore.car.set(null);
		component.archive(driveSession());
		detect();
		expect(
			(fixture.nativeElement as HTMLElement).querySelector('form'),
		).toBeNull();
		expect(store.archiveDriveSession).not.toHaveBeenCalled();
	});
});
