import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { type Observable, Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebAuthnOptions } from './passkey-credentials';
import { PasskeyRegistrationCapability } from './passkey-registration-capability';
import { PasskeyStore } from './passkey-store';
import type { Passkey, SettingsGatewayFailure } from './settings.models';
import { SettingsGateway } from './settings-gateway';

const passkey = (overrides: Partial<Passkey> = {}): Passkey => ({
	id: 'passkey-1',
	name: 'Workshop laptop',
	createdAt: '2026-08-09T18:00:00.000Z',
	...overrides,
});

class FakeSettingsGateway {
	private readonly passkeyValue = signal<Passkey[] | undefined>(undefined);
	private readonly passkeyLoading = signal(false);
	private readonly passkeyReadFailure = signal<SettingsGatewayFailure | null>(
		null,
	);
	private optionsResult = new Subject<WebAuthnOptions>();
	private verifyResult = new Subject<void>();
	private renameResult = new Subject<void>();
	private revokeResult = new Subject<void>();

	readonly passkeys = {
		hasValue: () => this.passkeyValue() !== undefined,
		value: () => this.passkeyValue() ?? [],
		isLoading: this.passkeyLoading,
		reload: vi.fn(),
	};
	readonly passkeyFailure = vi.fn(() => this.passkeyReadFailure());
	readonly registrationOptions = vi.fn(
		(_name: string): Observable<WebAuthnOptions> =>
			this.optionsResult.asObservable(),
	);
	readonly verifyRegistration = vi.fn(
		(
			_name: string,
			_response: Readonly<Record<string, unknown>>,
		): Observable<void> => this.verifyResult.asObservable(),
	);
	readonly renamePasskey = vi.fn(
		(_passkey: Passkey, _name: string): Observable<void> =>
			this.renameResult.asObservable(),
	);
	readonly revokePasskey = vi.fn(
		(_passkey: Passkey): Observable<void> => this.revokeResult.asObservable(),
	);

	setPasskeys(value: Passkey[] | undefined): void {
		this.passkeyValue.set(value);
	}

	setLoading(value: boolean): void {
		this.passkeyLoading.set(value);
	}

	setReadFailure(value: SettingsGatewayFailure | null): void {
		this.passkeyReadFailure.set(value);
	}

	resetOptions(): void {
		this.optionsResult = new Subject<WebAuthnOptions>();
	}

	resetVerify(): void {
		this.verifyResult = new Subject<void>();
	}

	resetRename(): void {
		this.renameResult = new Subject<void>();
	}

	resetRevoke(): void {
		this.revokeResult = new Subject<void>();
	}

	succeedOptions(value: WebAuthnOptions): void {
		this.optionsResult.next(value);
		this.optionsResult.complete();
	}

	failOptions(value: SettingsGatewayFailure): void {
		this.optionsResult.error(value);
	}

	succeedVerify(): void {
		this.verifyResult.next();
		this.verifyResult.complete();
	}

	succeedRename(): void {
		this.renameResult.next();
		this.renameResult.complete();
	}

	failRename(value: SettingsGatewayFailure): void {
		this.renameResult.error(value);
	}

	succeedRevoke(): void {
		this.revokeResult.next();
		this.revokeResult.complete();
	}

	failRevoke(value: SettingsGatewayFailure): void {
		this.revokeResult.error(value);
	}
}

class FakePasskeyRegistrationCapability {
	available = true;
	private registerResult = new Subject<Record<string, unknown>>();
	readonly register = vi.fn(
		(_options: WebAuthnOptions): Observable<Record<string, unknown>> =>
			this.registerResult.asObservable(),
	);

	resetRegister(): void {
		this.registerResult = new Subject<Record<string, unknown>>();
	}

	succeedRegister(value: Record<string, unknown>): void {
		this.registerResult.next(value);
		this.registerResult.complete();
	}

	failRegister(value: unknown): void {
		this.registerResult.error(value);
	}
}

describe('PasskeyStore', () => {
	let gateway: FakeSettingsGateway;
	let registration: FakePasskeyRegistrationCapability;
	let store: InstanceType<typeof PasskeyStore>;

	beforeEach(() => {
		gateway = new FakeSettingsGateway();
		registration = new FakePasskeyRegistrationCapability();
		TestBed.configureTestingModule({
			providers: [
				PasskeyStore,
				{ provide: SettingsGateway, useValue: gateway },
				{
					provide: PasskeyRegistrationCapability,
					useValue: registration,
				},
			],
		});
		store = TestBed.inject(PasskeyStore);
	});

	afterEach(() => TestBed.resetTestingModule());

	it('publishes resource, capability, loading, read failure, and retry state', () => {
		expect(store.passkeys()).toEqual([]);
		expect(store.loading()).toBe(false);
		expect(store.readError()).toBe('');
		expect(store.webAuthnAvailable()).toBe(true);
		expect(store.action()).toBeNull();
		expect(store.message()).toBe('');
		expect(store.actionError()).toBe('');
		gateway.setPasskeys([passkey()]);
		expect(store.passkeys()).toEqual([passkey()]);
		gateway.setLoading(true);
		expect(store.loading()).toBe(true);
		gateway.setReadFailure({ kind: 'unavailable' });
		expect(store.readError()).toContain('could not be loaded');
		store.retry();
		expect(gateway.passkeys.reload).toHaveBeenCalledOnce();
	});

	it('validates names and honors browser availability before registering', () => {
		registration.available = false;
		store.register('Workshop key');
		expect(gateway.registrationOptions).not.toHaveBeenCalled();
		registration.available = true;

		store.register('   ');
		expect(store.actionError()).toContain('80 characters or fewer');
		store.rename(passkey(), 'x'.repeat(81));
		expect(store.actionError()).toContain('80 characters or fewer');
		expect(gateway.renamePasskey).not.toHaveBeenCalled();
	});

	it('runs the full registration ceremony once and publishes success', () => {
		store.register('  Workshop key  ');
		expect(gateway.registrationOptions).toHaveBeenCalledWith('Workshop key');
		expect(store.action()).toBe('register');
		store.register('Duplicate');
		store.rename(passkey(), 'Duplicate');
		store.revoke(passkey());
		expect(gateway.registrationOptions).toHaveBeenCalledOnce();

		const options = { challenge: 'AQID' };
		gateway.succeedOptions(options);
		expect(registration.register).toHaveBeenCalledWith(options);
		const response = { id: 'credential-1' };
		registration.succeedRegister(response);
		expect(gateway.verifyRegistration).toHaveBeenCalledWith(
			'Workshop key',
			response,
		);
		gateway.succeedVerify();
		expect(store.message()).toContain('Passkey added');
		expect(gateway.passkeys.reload).toHaveBeenCalledOnce();
		expect(store.outcome()).toMatchObject({
			status: 'succeeded',
			operationId: 1,
		});
	});

	it('maps browser ceremony cancellation and upstream registration failures', () => {
		store.register('Workshop key');
		gateway.succeedOptions({ challenge: 'AQID' });
		registration.failRegister(
			new DOMException('The owner cancelled.', 'NotAllowedError'),
		);
		expect(store.actionError()).toContain('cancelled or timed out');

		gateway.resetOptions();
		registration.resetRegister();
		store.register('Workshop key');
		gateway.failOptions({ kind: 'unavailable' });
		expect(store.actionError()).toContain('could not be completed');
	});

	it('renames and revokes passkeys with typed outcomes', () => {
		const current = passkey();
		store.rename(current, '  Pit tablet  ');
		expect(gateway.renamePasskey).toHaveBeenCalledWith(current, 'Pit tablet');
		expect(store.action()).toBe('rename:passkey-1');
		gateway.succeedRename();
		expect(store.message()).toBe('Passkey renamed.');

		store.revoke(current);
		expect(store.action()).toBe('revoke:passkey-1');
		gateway.succeedRevoke();
		expect(store.message()).toContain('Passkey revoked');
		expect(gateway.passkeys.reload).toHaveBeenCalledTimes(2);
	});

	it('preserves server messages and maps generic passkey failures', () => {
		store.rename(passkey(), 'Pit tablet');
		gateway.failRename({
			kind: 'http',
			status: 409,
			message: 'That passkey name is already in use.',
		});
		expect(store.actionError()).toBe('That passkey name is already in use.');
		expect(store.message()).toBe('');

		gateway.resetRename();
		store.rename(passkey(), 'Pit tablet');
		gateway.failRename({ kind: 'http', status: 500 });
		expect(store.actionError()).toContain('could not be completed');

		store.revoke(passkey());
		gateway.failRevoke({ kind: 'unavailable' });
		expect(store.actionError()).toContain('could not be completed');
	});
});
