import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultTimezone, type TimezonePreference } from './settings.models';
import {
	TimezoneGateway,
	type TimezoneGatewayFailure,
} from './timezone-gateway';
import { type SaveTimezoneCommand, TimezoneStore } from './timezone-store';

class FakeTimezoneGateway {
	private readonly preferenceValue = signal<TimezonePreference | undefined>(
		undefined,
	);
	private readonly preferenceError = signal<unknown>(undefined);
	private readonly preferenceLoading = signal(false);
	private mutation = new Subject<TimezonePreference>();
	readonly preference = {
		hasValue: () => this.preferenceValue() !== undefined,
		value: () => this.preferenceValue() ?? { timezone: null },
		error: this.preferenceError,
		isLoading: this.preferenceLoading,
	};
	readonly saveTimezone = vi.fn(
		(_command: SaveTimezoneCommand): Observable<TimezonePreference> =>
			this.mutation.asObservable(),
	);
	readonly refresh = vi.fn();

	setPreference(preference: TimezonePreference | undefined): void {
		this.preferenceValue.set(preference);
	}

	setReadError(error: unknown): void {
		this.preferenceError.set(error);
	}

	setLoading(loading: boolean): void {
		this.preferenceLoading.set(loading);
	}

	succeed(preference: TimezonePreference): void {
		this.mutation.next(preference);
		this.mutation.complete();
	}

	fail(failure: TimezoneGatewayFailure): void {
		this.mutation.error(failure);
	}

	resetMutation(): void {
		this.mutation = new Subject<TimezonePreference>();
	}
}

describe('TimezoneStore', () => {
	let gateway: FakeTimezoneGateway;
	let store: InstanceType<typeof TimezoneStore>;

	beforeEach(() => {
		gateway = new FakeTimezoneGateway();
		TestBed.configureTestingModule({
			providers: [
				TimezoneStore,
				{ provide: TimezoneGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(TimezoneStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('owns read fallback, loading, retry, and refresh state', () => {
		expect(store.timezone()).toBe(defaultTimezone());
		gateway.setPreference({ timezone: 'Not/A-Timezone' });
		expect(store.timezone()).toBe(defaultTimezone());
		gateway.setPreference({ timezone: 'UTC' });
		expect(store.timezone()).toBe('UTC');

		gateway.setLoading(true);
		expect(store.loading()).toBe(true);
		expect(store.error()).toBe('');
		gateway.setReadError(new Error('offline'));
		expect(store.error()).toContain('could not be loaded');

		store.refresh();
		expect(gateway.refresh).toHaveBeenCalledOnce();
		gateway.setReadError(undefined);
		store.retry();
		expect(store.outcome()).toEqual({
			status: 'idle',
			operation: 'save-timezone',
			operationId: null,
		});
		expect(gateway.refresh).toHaveBeenCalledTimes(2);
	});

	it('validates saves, suppresses duplicates, and publishes typed outcomes', () => {
		store.saveTimezone({ timezone: 'Not/A_Timezone' });
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			operation: 'save-timezone',
			operationId: 1,
		});
		expect(store.error()).toContain('valid IANA timezone');

		store.saveTimezone({ timezone: ' UTC ' });
		expect(store.saving()).toBe(true);
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'save-timezone',
			operationId: 2,
		});
		expect(gateway.saveTimezone).toHaveBeenCalledWith({ timezone: 'UTC' });

		store.saveTimezone({ timezone: 'America/New_York' });
		expect(gateway.saveTimezone).toHaveBeenCalledOnce();
		gateway.succeed({ timezone: 'UTC' });
		expect(store.outcome()).toEqual({
			status: 'succeeded',
			operation: 'save-timezone',
			operationId: 2,
			timezone: 'UTC',
		});
		expect(store.message()).toBe('Dates will now use UTC.');
		expect(gateway.refresh).toHaveBeenCalledOnce();

		gateway.resetMutation();
		store.saveTimezone({ timezone: 'America/New_York' });
		gateway.fail({
			kind: 'rejected-response',
			message: 'That timezone is disabled.',
		});
		expect(store.outcome()).toMatchObject({
			status: 'failed',
			operation: 'save-timezone',
			operationId: 3,
		});
		expect(store.error()).toBe('That timezone is disabled.');
	});
});
