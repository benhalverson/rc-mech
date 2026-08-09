import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PasskeyRegistrationCapability } from './passkey-registration-capability';

class FakeCredential {
	readonly id = 'credential-1';
	readonly rawId = Uint8Array.from([1, 2, 3]).buffer;
	readonly type = 'public-key';
	readonly response = {
		clientDataJSON: Uint8Array.from([4]).buffer,
		attestationObject: Uint8Array.from([5]).buffer,
		getTransports: () => ['internal'] as AuthenticatorTransport[],
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return {};
	}
}

type CapabilityView = Window & {
	PublicKeyCredential: typeof FakeCredential;
};

const view = (overrides: Partial<CapabilityView> = {}): CapabilityView =>
	({
		PublicKeyCredential: FakeCredential,
		isSecureContext: true,
		location: { hostname: 'example.com' },
		navigator: {
			credentials: { create: vi.fn().mockResolvedValue(new FakeCredential()) },
		},
		atob: window.atob.bind(window),
		btoa: window.btoa.bind(window),
		...overrides,
	}) as unknown as CapabilityView;

const capabilityFor = (
	defaultView: Window | null,
): PasskeyRegistrationCapability => {
	TestBed.configureTestingModule({
		providers: [
			PasskeyRegistrationCapability,
			{ provide: DOCUMENT, useValue: { defaultView } },
		],
	});
	return TestBed.inject(PasskeyRegistrationCapability);
};

describe('PasskeyRegistrationCapability', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('completes a browser passkey ceremony', async () => {
		const browser = view();
		const capability = capabilityFor(browser);
		expect(capability.available).toBe(true);

		const response = await firstValueFrom(
			capability.register({
				challenge: 'AQID',
				user: { id: 'BAUG', name: 'owner', displayName: 'Owner' },
				excludeCredentials: [{ id: 'BwgJ', type: 'public-key' }],
			}),
		);
		expect(browser.navigator.credentials.create).toHaveBeenCalledWith({
			publicKey: expect.objectContaining({
				challenge: expect.any(Uint8Array),
				user: expect.objectContaining({ id: expect.any(Uint8Array) }),
			}),
		});
		expect(response).toMatchObject({
			id: 'credential-1',
			rawId: 'AQID',
			response: { clientDataJSON: 'BA', attestationObject: 'BQ' },
		});
	});

	it('rejects missing and insecure browser capabilities', async () => {
		const missing = capabilityFor(null);
		expect(missing.available).toBe(false);
		await expect(
			firstValueFrom(missing.register({ challenge: 'AQID' })),
		).rejects.toThrow('Passkeys unavailable');
		TestBed.resetTestingModule();

		const remote = capabilityFor(
			view({
				isSecureContext: false,
				location: { hostname: 'garage.example' } as Location,
			}),
		);
		expect(remote.available).toBe(false);
		await expect(
			firstValueFrom(remote.register({ challenge: 'AQID' })),
		).rejects.toThrow('Passkeys unavailable');
	});

	it('allows local development origins', () => {
		for (const hostname of ['localhost', '127.0.0.1']) {
			const capability = capabilityFor(
				view({
					isSecureContext: false,
					location: { hostname } as Location,
				}),
			);
			expect(capability.available).toBe(true);
			TestBed.resetTestingModule();
		}
	});

	it('rejects an empty browser credential response', async () => {
		const browser = view({
			navigator: {
				credentials: { create: vi.fn().mockResolvedValue(null) },
			} as unknown as Navigator,
		});
		await expect(
			firstValueFrom(capabilityFor(browser).register({ challenge: 'AQID' })),
		).rejects.toThrow('No passkey was returned by the browser.');
	});
});
