type WebAuthnOptions = {
	challenge: string;
	user?: { id: string; name: string; displayName: string };
	excludeCredentials?: Array<{
		id: string;
		type: 'public-key';
		transports?: AuthenticatorTransport[];
	}>;
	[key: string]: unknown;
};

const base64UrlToBytes = (value: string): Uint8Array => {
	const normalized = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(window.atob(normalized), (character) =>
		character.charCodeAt(0),
	);
};

const bytesToBase64Url = (value: ArrayBuffer): string => {
	let binary = '';
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return window
		.btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
};

export const registrationOptions = (
	options: WebAuthnOptions,
): PublicKeyCredentialCreationOptions =>
	({
		...options,
		challenge: base64UrlToBytes(options.challenge),
		user: options.user
			? { ...options.user, id: base64UrlToBytes(options.user.id) }
			: undefined,
		excludeCredentials: options.excludeCredentials?.map((item) => ({
			...item,
			id: base64UrlToBytes(item.id),
		})),
	}) as unknown as PublicKeyCredentialCreationOptions;

export const registrationResponse = (
	credential: PublicKeyCredential,
): Record<string, unknown> => {
	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		rawId: bytesToBase64Url(credential.rawId),
		response: {
			clientDataJSON: bytesToBase64Url(response.clientDataJSON),
			attestationObject: bytesToBase64Url(response.attestationObject),
			transports: response.getTransports?.(),
		},
		type: credential.type,
		clientExtensionResults: credential.getClientExtensionResults(),
	};
};

export const webAuthnError = (error: unknown): string => {
	if (error instanceof DOMException && error.name === 'NotAllowedError')
		return 'The passkey ceremony was cancelled or timed out.';
	return 'The passkey request could not be completed. Try again or use a magic link.';
};

export type { WebAuthnOptions };
