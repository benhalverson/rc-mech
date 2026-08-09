import {
	array,
	email,
	enum as enumSchema,
	literal,
	minLength,
	number,
	object,
	optional,
	positive,
	record,
	string,
	unknown,
} from 'zod/mini';
import type * as z from 'zod/mini';

const authenticatorTransportSchema = enumSchema([
	'ble',
	'cable',
	'hybrid',
	'internal',
	'nfc',
	'smart-card',
	'usb',
]);

export const accessResponseSchema = object({ status: literal(true) });

export const passkeyRequestOptionsSchema = object({
	challenge: string().check(minLength(1)),
	timeout: optional(number().check(positive())),
	rpId: optional(string().check(minLength(1))),
	allowCredentials: optional(
		array(
			object({
				id: string().check(minLength(1)),
				type: literal('public-key'),
				transports: optional(array(authenticatorTransportSchema)),
			}),
		),
	),
	userVerification: optional(
		enumSchema(['discouraged', 'preferred', 'required']),
	),
	extensions: optional(record(string(), unknown())),
});

export const verifiedAuthenticationSchema = object({
	session: object({ id: string().check(minLength(1)) }),
	user: object({
		id: optional(string().check(minLength(1))),
		email: optional(email()),
	}),
});

export type PasskeyRequestOptions = z.infer<typeof passkeyRequestOptionsSchema>;

export type PasskeyAssertion = Readonly<{
	id: string;
	rawId: string;
	response: Readonly<{
		clientDataJSON: string;
		authenticatorData: string;
		signature: string;
		userHandle?: string;
	}>;
	type: string;
	clientExtensionResults: AuthenticationExtensionsClientOutputs;
}>;

export type RequestMagicLinkCommand = Readonly<{
	operation: 'request-magic-link';
	email: string;
}>;

export type RegisterCommand = Readonly<{
	operation: 'register';
	email: string;
	inviteCode: string;
}>;

export type AuthenticatePasskeyCommand = Readonly<{
	operation: 'authenticate-passkey';
}>;

export type VerifyPasskeyCommand = Readonly<{
	response: PasskeyAssertion;
}>;

export type AuthenticationOperation =
	| RequestMagicLinkCommand['operation']
	| RegisterCommand['operation']
	| AuthenticatePasskeyCommand['operation'];

export type AuthenticationGatewayFailure =
	| { readonly kind: 'rate-limited'; readonly status: 429 }
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'unavailable' }
	| { readonly kind: 'invalid-response' };

export type PasskeyCapabilityFailure =
	| { readonly kind: 'cancelled' }
	| { readonly kind: 'missing-credential' }
	| { readonly kind: 'unavailable' };

export type AuthenticationFailure =
	| AuthenticationGatewayFailure
	| PasskeyCapabilityFailure;

export type AuthenticationOutcome =
	| { readonly status: 'idle'; readonly operationId: null }
	| {
			readonly status: 'pending';
			readonly operation: AuthenticationOperation;
			readonly operationId: number;
	  }
	| {
			readonly status: 'succeeded';
			readonly operation: AuthenticationOperation;
			readonly operationId: number;
	  }
	| {
			readonly status: 'failed';
			readonly operation: AuthenticationOperation;
			readonly operationId: number;
			readonly error: AuthenticationFailure;
	  };
