import { TestBed } from '@angular/core/testing';
import { ActivatedRoute, Router } from '@angular/router';
import {
	BehaviorSubject,
	type Observable,
	of,
	Subject,
	throwError,
} from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OwnerSessionStore } from '../owner-session-store';
import type {
	PasskeyAssertion,
	PasskeyRequestOptions,
	RegisterCommand,
	RequestMagicLinkCommand,
	VerifyPasskeyCommand,
} from './authentication.models';
import { AuthenticationGateway } from './authentication-gateway';
import { AuthenticationStore } from './authentication-store';
import { PasskeyCapability } from './passkey-capability';

const assertion: PasskeyAssertion = {
	id: 'passkey-1',
	rawId: 'AQID',
	response: {
		clientDataJSON: 'BA',
		authenticatorData: 'BQ',
		signature: 'Bg',
	},
	type: 'public-key',
	clientExtensionResults: {},
};

class FakeAuthenticationGateway {
	accessResponse = new Subject<void>();
	readonly requestMagicLink = vi.fn(
		(_command: RequestMagicLinkCommand, _returnTo: string): Observable<void> =>
			this.accessResponse,
	);
	readonly register = vi.fn(
		(_command: RegisterCommand, _returnTo: string): Observable<void> =>
			this.accessResponse,
	);
	readonly authenticationOptions = vi.fn<
		() => Observable<PasskeyRequestOptions>
	>(() => of({ challenge: 'AQ' }));
	readonly verifyAuthentication = vi.fn(
		(_command: VerifyPasskeyCommand): Observable<void> => of(undefined),
	);
}

class FakePasskeyCapability {
	available = true;
	readonly authenticate = vi.fn(() => of(assertion));
}

const query = (values: Record<string, string>) => ({
	get: (name: string) => values[name] ?? null,
	has: (name: string) => name in values,
});

describe('AuthenticationStore', () => {
	let gateway: FakeAuthenticationGateway;
	let passkey: FakePasskeyCapability;
	let refresh: ReturnType<typeof vi.fn>;
	let navigateByUrl: ReturnType<typeof vi.fn>;
	let store: InstanceType<typeof AuthenticationStore>;
	let routeParameters: BehaviorSubject<ReturnType<typeof query>>;

	beforeEach(() => {
		gateway = new FakeAuthenticationGateway();
		passkey = new FakePasskeyCapability();
		refresh = vi.fn().mockResolvedValue(null);
		navigateByUrl = vi.fn().mockResolvedValue(true);
		routeParameters = new BehaviorSubject(
			query({
				returnTo: '/garage/car-42/photos',
				reason: 'session-expired',
			}),
		);
		TestBed.configureTestingModule({
			providers: [
				AuthenticationStore,
				{ provide: AuthenticationGateway, useValue: gateway },
				{ provide: PasskeyCapability, useValue: passkey },
				{ provide: OwnerSessionStore, useValue: { refresh } },
				{ provide: Router, useValue: { navigateByUrl } },
				{
					provide: ActivatedRoute,
					useValue: {
						queryParamMap: routeParameters,
						snapshot: {
							queryParamMap: routeParameters.value,
						},
					},
				},
			],
		});
		store = TestBed.inject(AuthenticationStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('owns validated route context, idle state, and feedback reset', () => {
		expect(store.returnTo()).toBe('/garage/car-42/photos');
		expect(store.message()).toContain('session has expired');
		expect(store.accessOutcome()).toEqual({
			status: 'idle',
			operationId: null,
		});
		expect(store.passkeyOutcome()).toEqual({
			status: 'idle',
			operationId: null,
		});
		expect(store.sending()).toBe(false);
		expect(store.working()).toBe(false);
		expect(store.webAuthnAvailable()).toBe(true);

		store.resetFeedback();
		expect(store.message()).toBe('');
		expect(store.sent()).toBe(false);
	});

	it('reacts to query-only navigation without retaining stale feedback', () => {
		store.requestMagicLink({
			operation: 'request-magic-link',
			email: 'owner@example.test',
		});
		gateway.accessResponse.next();
		gateway.accessResponse.complete();
		expect(store.sent()).toBe(true);

		routeParameters.next(
			query({ returnTo: '/settings', error_description: 'expired' }),
		);
		expect(store.returnTo()).toBe('/settings');
		expect(store.message()).toContain('recovery link could not be used');
		expect(store.sent()).toBe(false);

		gateway.accessResponse = new Subject<void>();
		store.requestMagicLink({
			operation: 'request-magic-link',
			email: 'owner@example.test',
		});
		expect(gateway.requestMagicLink).toHaveBeenLastCalledWith(
			expect.anything(),
			'/settings',
		);
	});

	it('suppresses duplicate magic-link commands and publishes success', () => {
		const command = {
			operation: 'request-magic-link',
			email: 'owner@example.test',
		} as const;
		store.requestMagicLink(command);

		expect(store.sending()).toBe(true);
		expect(store.accessOutcome()).toEqual({
			status: 'pending',
			operation: 'request-magic-link',
			operationId: 1,
		});
		expect(gateway.requestMagicLink).toHaveBeenCalledWith(
			command,
			'/garage/car-42/photos',
		);
		store.requestMagicLink(command);
		expect(gateway.requestMagicLink).toHaveBeenCalledOnce();

		gateway.accessResponse.next();
		gateway.accessResponse.complete();
		expect(store.sent()).toBe(true);
		expect(store.message()).toContain('sign-in link is on its way');
		expect(store.accessOutcome()).toEqual({
			status: 'succeeded',
			operation: 'request-magic-link',
			operationId: 1,
		});
	});

	it('publishes registration success and operation IDs', () => {
		const command = {
			operation: 'register',
			email: 'owner@example.test',
			inviteCode: 'TRACK-01',
		} as const;
		store.register(command);
		expect(gateway.register).toHaveBeenCalledWith(
			command,
			'/garage/car-42/photos',
		);
		gateway.accessResponse.next();
		gateway.accessResponse.complete();

		expect(store.sent()).toBe(true);
		expect(store.message()).toContain('registration link is on its way');
		expect(store.accessOutcome()).toEqual({
			status: 'succeeded',
			operation: 'register',
			operationId: 1,
		});
	});

	it('maps rate limits and generic access failures without exposing validity', () => {
		store.requestMagicLink({
			operation: 'request-magic-link',
			email: 'owner@example.test',
		});
		gateway.accessResponse.error({ kind: 'rate-limited', status: 429 });
		expect(store.message()).toContain('Too many requests');
		expect(store.accessOutcome()).toMatchObject({
			status: 'failed',
			operation: 'request-magic-link',
			operationId: 1,
			error: { kind: 'rate-limited' },
		});

		gateway.accessResponse = new Subject<void>();
		store.requestMagicLink({
			operation: 'request-magic-link',
			email: 'owner@example.test',
		});
		gateway.accessResponse.error({ kind: 'http', status: 503 });
		expect(store.message()).toContain('Check the address and try again');

		gateway.accessResponse = new Subject<void>();
		store.register({
			operation: 'register',
			email: 'owner@example.test',
			inviteCode: 'TRACK-01',
		});
		gateway.accessResponse.error({ kind: 'http', status: 503 });
		expect(store.message()).toContain('Check the details and try again');
		expect(store.accessOutcome()).toMatchObject({
			status: 'failed',
			operation: 'register',
			operationId: 3,
			error: { kind: 'http', status: 503 },
		});
	});

	it('verifies a passkey, refreshes the session, and returns to the route', async () => {
		store.authenticateWithPasskey({ operation: 'authenticate-passkey' });
		expect(store.working()).toBe(true);
		expect(store.passkeyOutcome()).toEqual({
			status: 'pending',
			operation: 'authenticate-passkey',
			operationId: 1,
		});

		await vi.waitFor(() => {
			expect(gateway.authenticationOptions).toHaveBeenCalledOnce();
			expect(passkey.authenticate).toHaveBeenCalledWith({ challenge: 'AQ' });
			expect(gateway.verifyAuthentication).toHaveBeenCalledWith({
				response: assertion,
			});
			expect(refresh).toHaveBeenCalledOnce();
			expect(navigateByUrl).toHaveBeenCalledWith('/garage/car-42/photos');
			expect(store.passkeyOutcome()).toEqual({
				status: 'succeeded',
				operation: 'authenticate-passkey',
				operationId: 1,
			});
		});
	});

	it('suppresses duplicate passkey commands and maps cancellation', async () => {
		const ceremony = new Subject<PasskeyAssertion>();
		passkey.authenticate.mockReturnValue(ceremony);
		store.authenticateWithPasskey({ operation: 'authenticate-passkey' });
		store.authenticateWithPasskey({ operation: 'authenticate-passkey' });
		expect(gateway.authenticationOptions).toHaveBeenCalledOnce();
		expect(passkey.authenticate).toHaveBeenCalledOnce();

		ceremony.error({ kind: 'cancelled' });
		await vi.waitFor(() => {
			expect(store.message()).toContain('cancelled or timed out');
			expect(store.passkeyOutcome()).toMatchObject({
				status: 'failed',
				operationId: 1,
				error: { kind: 'cancelled' },
			});
		});
	});

	it('maps unknown passkey workflow failures to unavailable', async () => {
		gateway.authenticationOptions.mockReturnValue(
			throwError(() => new Error('offline')),
		);
		store.authenticateWithPasskey({ operation: 'authenticate-passkey' });

		await vi.waitFor(() => {
			expect(store.message()).toContain(
				'passkey request could not be completed',
			);
			expect(store.passkeyOutcome()).toMatchObject({
				status: 'failed',
				error: { kind: 'unavailable' },
			});
		});
	});

	it('ignores passkey commands when the capability is unavailable', () => {
		passkey.available = false;
		expect(store.webAuthnAvailable()).toBe(false);
		store.authenticateWithPasskey({ operation: 'authenticate-passkey' });

		expect(gateway.authenticationOptions).not.toHaveBeenCalled();
		expect(store.passkeyOutcome()).toEqual({
			status: 'idle',
			operationId: null,
		});
	});
});
