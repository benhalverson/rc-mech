import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject, type Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from '../owner-session-store';
import {
	SignOutGateway,
	type SignOutGatewayFailure,
	type SignOutResponse,
} from './sign-out-gateway';
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
	let store: InstanceType<typeof SignOutStore>;

	beforeEach(() => {
		gateway = new FakeSignOutGateway();
		navigate = vi.fn(() => Promise.resolve(true));
		expire = vi.fn();
		TestBed.configureTestingModule({
			providers: [
				SignOutStore,
				{ provide: SignOutGateway, useValue: gateway },
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
		expect(gateway.signOut).toHaveBeenCalledOnce();
		gateway.succeed();
		expect(expire).toHaveBeenCalledOnce();
		await vi.waitFor(() =>
			expect(store.outcome()).toEqual({
				status: 'succeeded',
				operation: 'sign-out',
				operationId: 1,
			}),
		);
		expect(navigate).toHaveBeenCalledWith(['/sign-in']);
		expect(store.error()).toBe('');

		gateway.reset();
		store.signOut(command);
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
		gateway.succeed();
		await vi.waitFor(() => expect(store.outcome().status).toBe('succeeded'));
		expect(expire).toHaveBeenCalledOnce();
	});
});
