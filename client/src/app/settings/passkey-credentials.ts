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

const base64UrlToBytes = (value: string, view: Window): Uint8Array => {
	const normalized = value
		.replace(/-/g, '+')
		.replace(/_/g, '/')
		.padEnd(Math.ceil(value.length / 4) * 4, '=');
	return Uint8Array.from(view.atob(normalized), (character) =>
		character.charCodeAt(0),
	);
};

const bytesToBase64Url = (value: ArrayBuffer, view: Window): string => {
	let binary = '';
	for (const byte of new Uint8Array(value)) binary += String.fromCharCode(byte);
	return view
		.btoa(binary)
		.replace(/\+/g, '-')
		.replace(/\//g, '_')
		.replace(/=+$/, '');
};

export const registrationOptions = (
	options: WebAuthnOptions,
	view: Window = window,
): PublicKeyCredentialCreationOptions =>
	({
		...options,
		challenge: base64UrlToBytes(options.challenge, view),
		user: options.user
			? { ...options.user, id: base64UrlToBytes(options.user.id, view) }
			: undefined,
		excludeCredentials: options.excludeCredentials?.map((item) => ({
			...item,
			id: base64UrlToBytes(item.id, view),
		})),
	}) as unknown as PublicKeyCredentialCreationOptions;

export const registrationResponse = (
	credential: PublicKeyCredential,
	view: Window = window,
): Record<string, unknown> => {
	const response = credential.response as AuthenticatorAttestationResponse;
	return {
		id: credential.id,
		rawId: bytesToBase64Url(credential.rawId, view),
		response: {
			clientDataJSON: bytesToBase64Url(response.clientDataJSON, view),
			attestationObject: bytesToBase64Url(response.attestationObject, view),
			transports: response.getTransports?.(),
		},
		type: credential.type,
		clientExtensionResults: credential.getClientExtensionResults(),
	};
};

export const webAuthnError = (error: unknown): string => {
	if (error instanceof DOMException && error.name === 'NotAllowedError')
		return 'The passkey ceremony was cancelled or timed out.';
	if (
		error instanceof Error &&
		error.message === 'No passkey was returned by the browser.'
	)
		return error.message;
	return 'The passkey request could not be completed. Try again or use a magic link.';
};

export type { WebAuthnOptions };
