import { describe, expect, it } from 'vitest';
import {
	registrationOptions,
	registrationResponse,
	webAuthnError,
} from './passkey-credentials';

const bytes = (value: BufferSource): number[] =>
	Array.from(
		value instanceof ArrayBuffer
			? new Uint8Array(value)
			: new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
	);

class TestCredential {
	readonly id = 'credential-1';
	readonly rawId = Uint8Array.from([251, 255]).buffer;
	readonly type = 'public-key';
	readonly response: {
		clientDataJSON: ArrayBuffer;
		attestationObject: ArrayBuffer;
		getTransports?: () => AuthenticatorTransport[];
	} = {
		clientDataJSON: Uint8Array.from([1]).buffer,
		attestationObject: Uint8Array.from([2]).buffer,
	};

	getClientExtensionResults(): AuthenticationExtensionsClientOutputs {
		return { credProps: { rk: true } };
	}
}

describe('passkey credential conversion', () => {
	it('decodes required and optional registration fields', () => {
		const minimal = registrationOptions({ challenge: 'AQ' });
		expect(bytes(minimal.challenge)).toEqual([1]);
		expect(minimal.user).toBeUndefined();
		expect(minimal.excludeCredentials).toBeUndefined();

		const complete = registrationOptions({
			challenge: 'AQID',
			user: { id: 'BA', name: 'owner', displayName: 'Owner' },
			excludeCredentials: [
				{ id: 'BQ', type: 'public-key', transports: ['internal'] },
			],
		});
		expect(bytes(complete.user.id)).toEqual([4]);
		expect(
			bytes(complete.excludeCredentials?.[0]?.id ?? new ArrayBuffer(0)),
		).toEqual([5]);
	});

	it('encodes a registration response with and without transports', () => {
		const credential = new TestCredential();
		let response = registrationResponse(
			credential as unknown as PublicKeyCredential,
		);
		expect(response['rawId']).toBe('-_8');
		expect(response['response']).toMatchObject({ transports: undefined });

		credential.response.getTransports = () => ['internal'];
		response = registrationResponse(
			credential as unknown as PublicKeyCredential,
		);
		expect(response['response']).toMatchObject({ transports: ['internal'] });
		expect(response['clientExtensionResults']).toEqual({
			credProps: { rk: true },
		});
	});

	it('describes cancellation, missing credentials, and generic failures', () => {
		expect(
			webAuthnError(new DOMException('cancelled', 'NotAllowedError')),
		).toContain('cancelled or timed out');
		expect(
			webAuthnError(new Error('No passkey was returned by the browser.')),
		).toBe('No passkey was returned by the browser.');
		expect(webAuthnError(new Error('offline'))).toContain(
			'could not be completed',
		);
		expect(webAuthnError('offline')).toContain('could not be completed');
	});
});
