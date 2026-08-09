import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	PasskeyCapability,
	passkeyCapabilityFailure,
} from './passkey-capability';

class FakePublicKeyCredential {
	readonly id = 'passkey-1';
	readonly rawId = Uint8Array.from([1, 2, 3]).buffer;
	readonly type = 'public-key';
	readonly response = {
		clientDataJSON: Uint8Array.from([4]).buffer,
		authenticatorData: Uint8Array.from([5]).buffer,
		signature: Uint8Array.from([6]).buffer,
		userHandle: Uint8Array.from([251, 255]).buffer as ArrayBuffer | null,
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return { credProps: { rk: true } };
	}
}

const browserDocument = (
	getCredential: ReturnType<typeof vi.fn>,
	credentialConstructor:
		| typeof FakePublicKeyCredential
		| null = FakePublicKeyCredential,
) => ({
	defaultView: {
		PublicKeyCredential: credentialConstructor ?? undefined,
		navigator: { credentials: { get: getCredential } },
		atob,
		btoa,
	},
});

describe('PasskeyCapability', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('converts passkey request options and assertion response values', async () => {
		const getCredential = vi
			.fn()
			.mockResolvedValue(new FakePublicKeyCredential());
		TestBed.configureTestingModule({
			providers: [
				PasskeyCapability,
				{ provide: DOCUMENT, useValue: browserDocument(getCredential) },
			],
		});
		const capability = TestBed.inject(PasskeyCapability);

		expect(capability.available).toBe(true);
		await expect(
			firstValueFrom(
				capability.authenticate({
					challenge: 'AQ',
					allowCredentials: [
						{ id: '-_8', type: 'public-key', transports: ['internal'] },
					],
				}),
			),
		).resolves.toEqual({
			id: 'passkey-1',
			rawId: 'AQID',
			response: {
				clientDataJSON: 'BA',
				authenticatorData: 'BQ',
				signature: 'Bg',
				userHandle: '-_8',
			},
			type: 'public-key',
			clientExtensionResults: { credProps: { rk: true } },
		});
		expect(getCredential).toHaveBeenCalledWith({
			publicKey: expect.objectContaining({
				challenge: Uint8Array.from([1]),
				allowCredentials: [
					expect.objectContaining({ id: Uint8Array.from([251, 255]) }),
				],
			}),
		});
	});

	it('omits an absent assertion user handle', async () => {
		const credential = new FakePublicKeyCredential();
		credential.response.userHandle = null;
		const getCredential = vi.fn().mockResolvedValue(credential);
		TestBed.configureTestingModule({
			providers: [
				PasskeyCapability,
				{ provide: DOCUMENT, useValue: browserDocument(getCredential) },
			],
		});

		const assertion = await firstValueFrom(
			TestBed.inject(PasskeyCapability).authenticate({ challenge: 'AQ' }),
		);
		expect(assertion.response.userHandle).toBeUndefined();
	});

	it('maps cancellation, missing credentials, and unavailable browsers', async () => {
		expect(passkeyCapabilityFailure({ kind: 'missing-credential' })).toEqual({
			kind: 'missing-credential',
		});
		expect(
			passkeyCapabilityFailure(
				new DOMException('The ceremony was cancelled.', 'NotAllowedError'),
			),
		).toEqual({ kind: 'cancelled' });
		expect(passkeyCapabilityFailure(new Error('offline'))).toEqual({
			kind: 'unavailable',
		});

		const getCredential = vi.fn().mockResolvedValue(null);
		TestBed.configureTestingModule({
			providers: [
				PasskeyCapability,
				{ provide: DOCUMENT, useValue: browserDocument(getCredential) },
			],
		});
		await expect(
			firstValueFrom(
				TestBed.inject(PasskeyCapability).authenticate({ challenge: 'AQ' }),
			),
		).rejects.toEqual({ kind: 'missing-credential' });

		TestBed.resetTestingModule();
		TestBed.configureTestingModule({
			providers: [
				PasskeyCapability,
				{
					provide: DOCUMENT,
					useValue: browserDocument(vi.fn(), null),
				},
			],
		});
		const unavailable = TestBed.inject(PasskeyCapability);
		expect(unavailable.available).toBe(false);
		await expect(
			firstValueFrom(unavailable.authenticate({ challenge: 'AQ' })),
		).rejects.toEqual({ kind: 'unavailable' });
	});

	it('is unavailable without a browser view', async () => {
		TestBed.configureTestingModule({
			providers: [
				PasskeyCapability,
				{ provide: DOCUMENT, useValue: { defaultView: null } },
			],
		});
		const capability = TestBed.inject(PasskeyCapability);
		const conversion = capability as unknown as {
			base64UrlToBytes(value: string): Uint8Array;
			bytesToBase64Url(value: ArrayBuffer): string;
		};

		expect(capability.available).toBe(false);
		expect(conversion.base64UrlToBytes('AQ')).toEqual(new Uint8Array());
		expect(
			conversion.bytesToBase64Url(Uint8Array.from([251, 255]).buffer),
		).toBe('');
		await expect(
			firstValueFrom(capability.authenticate({ challenge: 'AQ' })),
		).rejects.toEqual({ kind: 'unavailable' });
	});
});
