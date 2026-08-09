import { z } from 'zod';

const authenticatorTransportSchema = z.enum([
	'ble',
	'cable',
	'hybrid',
	'internal',
	'nfc',
	'smart-card',
	'usb',
]);

export const accessResponseSchema = z.object({ status: z.literal(true) });

export const passkeyRequestOptionsSchema = z.object({
	challenge: z.string().min(1),
	timeout: z.number().positive().optional(),
	rpId: z.string().min(1).optional(),
	allowCredentials: z
		.array(
			z.object({
				id: z.string().min(1),
				type: z.literal('public-key'),
				transports: z.array(authenticatorTransportSchema).optional(),
			}),
		)
		.optional(),
	userVerification: z.enum(['discouraged', 'preferred', 'required']).optional(),
	extensions: z.record(z.string(), z.unknown()).optional(),
});

export const verifiedAuthenticationSchema = z.object({
	session: z.object({ id: z.string().min(1) }),
	user: z.object({
		id: z.string().min(1).optional(),
		email: z.string().email().optional(),
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
