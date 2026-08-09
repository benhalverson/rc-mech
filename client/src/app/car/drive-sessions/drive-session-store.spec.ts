import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	ArchiveDriveSessionCommand,
	DriveSession,
	DriveSessionCollection,
	DriveSessionGatewayFailure,
	SaveDriveSessionCommand,
} from './drive-session.models';
import { DriveSessionGateway } from './drive-session-gateway';
import { DriveSessionStore } from './drive-session-store';
import { browserTimezone } from './drive-session-time';

const session = (overrides: Partial<DriveSession> = {}): DriveSession => ({
	id: 'drive-1',
	carId: 'car-1',
	startedAt: '2026-08-08T01:00:00.000Z',
	durationMinutes: null,
	conditions: null,
	notes: null,
	deletedAt: null,
	...overrides,
});

class FakeDriveSessionGateway {
	private readonly collectionValue = signal<DriveSessionCollection | undefined>(
		undefined,
	);
	private readonly collectionLoading = signal(false);
	private readonly collectionError = signal<unknown>(undefined);
	private readonly timezoneValue = signal<
		{ timezone: string | null } | undefined
	>(undefined);
	private readonly failure = signal<DriveSessionGatewayFailure | null>(null);
	private saveMutation = new Subject<DriveSession>();
	private archiveMutation = new Subject<DriveSession>();
	readonly collection = {
		hasValue: () => this.collectionValue() !== undefined,
		value: () => this.collectionValue() ?? { sessions: [], timezone: null },
		isLoading: this.collectionLoading,
		error: this.collectionError,
	};
	readonly timezone = {
		hasValue: () => this.timezoneValue() !== undefined,
		value: () => this.timezoneValue() ?? { timezone: null },
	};
	readonly selectCar = vi.fn();
	readonly refresh = vi.fn();
	readonly collectionFailure = vi.fn(() => this.failure());
	readonly saveDriveSession = vi.fn(
		(_command: SaveDriveSessionCommand): Observable<DriveSession> =>
			this.saveMutation.asObservable(),
	);
	readonly archiveDriveSession = vi.fn(
		(_command: ArchiveDriveSessionCommand): Observable<DriveSession> =>
			this.archiveMutation.asObservable(),
	);

	setCollection(value: DriveSessionCollection | undefined): void {
		this.collectionValue.set(value);
	}

	setTimezone(timezone: string | null): void {
		this.timezoneValue.set({ timezone });
	}

	setLoading(loading: boolean): void {
		this.collectionLoading.set(loading);
	}

	setFailure(failure: DriveSessionGatewayFailure | null): void {
		this.failure.set(failure);
	}

	succeedSave(value = session()): void {
		this.saveMutation.next(value);
		this.saveMutation.complete();
	}

	failSave(failure: DriveSessionGatewayFailure): void {
		this.saveMutation.error(failure);
	}

	succeedArchive(value = session({ deletedAt: 'now' })): void {
		this.archiveMutation.next(value);
		this.archiveMutation.complete();
	}

	failArchive(failure: DriveSessionGatewayFailure): void {
		this.archiveMutation.error(failure);
	}

	resetSave(): void {
		this.saveMutation = new Subject<DriveSession>();
	}

	resetArchive(): void {
		this.archiveMutation = new Subject<DriveSession>();
	}
}

describe('DriveSessionStore', () => {
	let gateway: FakeDriveSessionGateway;
	let store: InstanceType<typeof DriveSessionStore>;
	const saveCommand: SaveDriveSessionCommand = {
		carId: 'car-1',
		sessionId: null,
		draft: {
			startedAt: '2026-08-08T01:00:00.000Z',
			durationMinutes: null,
			conditions: '',
			notes: '',
		},
	};

	beforeEach(() => {
		gateway = new FakeDriveSessionGateway();
		TestBed.configureTestingModule({
			providers: [
				DriveSessionStore,
				{ provide: DriveSessionGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(DriveSessionStore);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it('owns selection, reads, timezone fallback, counts, and retries', () => {
		expect(store.sessions()).toEqual([]);
		expect(store.activeCount()).toBe(0);
		expect(store.timezone()).toBeTruthy();
		store.selectCar('car-1');
		store.selectCar('car-1');
		expect(gateway.selectCar).toHaveBeenCalledOnce();
		expect(gateway.selectCar).toHaveBeenCalledWith('car-1');

		gateway.setCollection({
			sessions: [session(), session({ id: 'deleted', deletedAt: 'now' })],
			timezone: 'UTC',
		});
		expect(store.sessions()).toHaveLength(2);
		expect(store.activeCount()).toBe(1);
		expect(store.timezone()).toBe('UTC');

		gateway.setCollection({ sessions: [], timezone: null });
		gateway.setTimezone('America/Los_Angeles');
		expect(store.timezone()).toBe('America/Los_Angeles');
		gateway.setCollection({ sessions: [], timezone: 'Not/A-Timezone' });
		expect(store.timezone()).toBe('America/Los_Angeles');
		gateway.setCollection({ sessions: [], timezone: null });
		gateway.setTimezone('Not/A-Timezone');
		expect(store.timezone()).toBe(browserTimezone());
		gateway.setLoading(true);
		expect(store.loading()).toBe(true);

		store.retry();
		store.refresh();
		expect(gateway.refresh).toHaveBeenCalledTimes(2);
	});

	it('maps authenticated and retryable read failures', () => {
		expect(store.failure()).toBeNull();
		gateway.setFailure({ kind: 'http', status: 401 });
		expect(store.failure()).toEqual({
			message: 'Your garage session has expired. Sign in again to continue.',
			retryable: false,
		});
		gateway.setFailure({ kind: 'invalid-response' });
		expect(store.failure()).toEqual({
			message: 'The drive session history could not be loaded.',
			retryable: true,
		});
	});

	it('suppresses duplicate saves and publishes success outcomes', () => {
		store.saveDriveSession(saveCommand);
		expect(gateway.saveDriveSession).not.toHaveBeenCalled();
		store.selectCar('car-1');
		store.saveDriveSession(saveCommand);
		expect(store.pending()).toBe(true);
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'save-drive-session',
			operationId: 1,
		});
		store.saveDriveSession({ ...saveCommand, sessionId: 'duplicate' });
		expect(gateway.saveDriveSession).toHaveBeenCalledOnce();

		gateway.succeedSave();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operation: 'save-drive-session',
			operationId: 1,
		});
		expect(store.error()).toBe('');
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});

	it('maps save failures and increments operation identity', () => {
		store.selectCar('car-1');
		store.saveDriveSession(saveCommand);
		gateway.failSave({ kind: 'http', status: 401 });
		expect(store.error()).toContain('session has expired');

		gateway.resetSave();
		store.saveDriveSession(saveCommand);
		gateway.failSave({
			kind: 'rejected-response',
			status: 422,
			message: 'Fix the drive session.',
		});
		expect(store.error()).toBe('Fix the drive session.');
		expect(store.outcome()).toMatchObject({ operationId: 2 });

		gateway.resetSave();
		store.saveDriveSession(saveCommand);
		gateway.failSave({ kind: 'http', status: 409 });
		expect(store.error()).toContain('Restore this car');

		gateway.resetSave();
		store.saveDriveSession(saveCommand);
		gateway.failSave({ kind: 'http', status: 503 });
		expect(store.error()).toContain('could not be saved');
	});

	it('owns archive concurrency, success, and failures', () => {
		const command = { carId: 'car-1', sessionId: 'drive-1' };
		store.selectCar('car-1');
		store.archiveDriveSession(command);
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operation: 'archive-drive-session',
			operationId: 1,
		});
		store.archiveDriveSession({ ...command, sessionId: 'duplicate' });
		expect(gateway.archiveDriveSession).toHaveBeenCalledOnce();
		gateway.succeedArchive();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operation: 'archive-drive-session',
		});

		gateway.resetArchive();
		store.archiveDriveSession(command);
		gateway.failArchive({ kind: 'unavailable' });
		expect(store.error()).toContain('could not be archived');
	});

	it('ignores stale mutation responses after the selected car changes', () => {
		store.selectCar('car-1');
		store.saveDriveSession(saveCommand);
		store.selectCar('car-2');
		expect(store.outcome()).toEqual({
			status: 'idle',
			operation: null,
			operationId: null,
		});
		gateway.succeedSave();
		expect(store.outcome().status).toBe('idle');
		expect(gateway.refresh).not.toHaveBeenCalled();

		gateway.resetArchive();
		store.archiveDriveSession({ carId: 'car-2', sessionId: 'drive-2' });
		store.selectCar('car-3');
		gateway.failArchive({ kind: 'http', status: 503 });
		expect(store.outcome().status).toBe('idle');
	});

	it('accepts a new-car command and rejects A-B-A stale completions', () => {
		store.selectCar('car-1');
		store.saveDriveSession(saveCommand);
		expect(gateway.saveDriveSession).toHaveBeenCalledOnce();

		store.selectCar('car-2');
		gateway.resetSave();
		store.saveDriveSession({ ...saveCommand, carId: 'car-2' });
		expect(gateway.saveDriveSession).toHaveBeenCalledTimes(2);
		expect(store.outcome()).toMatchObject({
			status: 'pending',
			operationId: 2,
		});

		store.selectCar('car-1');
		gateway.succeedSave(session({ carId: 'car-2' }));
		expect(store.outcome().status).toBe('idle');
		expect(gateway.refresh).not.toHaveBeenCalled();
	});

	it('guards outcomes with the captured route generation', () => {
		store.selectCar('car-1');
		store.saveDriveSession(saveCommand);
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.succeedSave();
		expect(store.outcome().status).toBe('pending');
		expect(gateway.refresh).not.toHaveBeenCalled();

		gateway.resetSave();
		store.saveDriveSession(saveCommand);
		(
			store as unknown as { selectionGeneration: { value: number } }
		).selectionGeneration.value += 1;
		gateway.failSave({ kind: 'unavailable' });
		expect(store.outcome().status).toBe('pending');
	});
});
