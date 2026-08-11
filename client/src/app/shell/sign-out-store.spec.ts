import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OfflineGarageStorage } from '../offline/offline-garage-storage';
import { OwnerSessionStore } from '../owner-session-store';
import { type SignOutGatewayFailure } from './sign-out-contract';
import { SignOutGateway } from './sign-out-gateway';
import type { SignOutResponse } from './sign-out-response';
import { type SignOutCommand, SignOutStore } from './sign-out-store';

class FakeSignOutGateway {
	private mutation = new Subject<SignOutResponse>();
	readonly signOut = vi.fn(
		(): Observable<SignOutResponse> => this.mutation.asObservable(),
	);

	succeed(): void {
		this.mutation.next({ success: true });
		this.mutation.complete();
	}

	fail(error: SignOutGatewayFailure): void {
		this.mutation.error(error);
	}

	reset(): void {
		this.mutation = new Subject<SignOutResponse>();
	}
}

describe('SignOutStore', () => {
	let gateway: FakeSignOutGateway;
	let navigate: ReturnType<typeof vi.fn>;
	let expire: ReturnType<typeof vi.fn>;
	let deactivate: ReturnType<typeof vi.fn>;
	let store: InstanceType<typeof SignOutStore>;

	beforeEach(() => {
		gateway = new FakeSignOutGateway();
		navigate = vi.fn(() => Promise.resolve(true));
		expire = vi.fn();
		deactivate = vi.fn(() => Promise.resolve());
		TestBed.configureTestingModule({
			providers: [
				SignOutStore,
				{ provide: SignOutGateway, useValue: gateway },
				{ provide: OfflineGarageStorage, useValue: { deactivate } },
				{ provide: Router, useValue: { navigate } },
				{ provide: OwnerSessionStore, useValue: { expire } },
			],
		});
		store = TestBed.inject(SignOutStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('starts idle with no loading or failure presentation', () => {
		expect(store.outcome()).toEqual({
			status: 'idle',
			operation: 'sign-out',
			operationId: null,
		});
		expect(store.signingOut()).toBe(false);
		expect(store.error()).toBe('');
	});

	it('suppresses duplicate commands and publishes successful outcomes', async () => {
		const command: SignOutCommand = { operation: 'sign-out' };
		expect(store.signOut(command)).toBeUndefined();
		expect(store.outcome()).toEqual({
			status: 'pending',
			operation: 'sign-out',
			operationId: 1,
		});
		expect(store.signingOut()).toBe(true);

		store.signOut(command);
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledOnce());
		gateway.succeed();
		await vi.waitFor(() =>
			expect(store.outcome()).toEqual({
				status: 'succeeded',
				operation: 'sign-out',
				operationId: 1,
			}),
		);
		expect(expire).toHaveBeenCalledOnce();
		expect(navigate).toHaveBeenCalledWith(['/sign-in']);
		expect(deactivate).toHaveBeenCalledOnce();
		expect(store.error()).toBe('');

		gateway.reset();
		store.signOut(command);
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledTimes(2));
		gateway.fail({ kind: 'http', status: 503 });
		expect(store.outcome()).toEqual({
			status: 'failed',
			operation: 'sign-out',
			operationId: 2,
			error: { kind: 'http', status: 503 },
		});
		expect(store.error()).toContain('could not sign you out');
	});

	it('preserves successful sign-out when navigation cannot complete', async () => {
		navigate.mockRejectedValueOnce(new Error('navigation failed'));
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() => expect(gateway.signOut).toHaveBeenCalledOnce());
		gateway.succeed();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(expire).toHaveBeenCalledOnce();
	});

	it('does not end the server session when offline cleanup fails', async () => {
		deactivate.mockRejectedValueOnce(new Error('IndexedDB unavailable'));
		store.signOut({ operation: 'sign-out' });
		await vi.waitFor(() => expect(store.outcome().status).toBe('failed'));
		expect(store.outcome()).toMatchObject({
			error: { kind: 'unavailable' },
		});
		expect(gateway.signOut).not.toHaveBeenCalled();
		expect(expire).not.toHaveBeenCalled();
		expect(navigate).not.toHaveBeenCalled();
	});
});
