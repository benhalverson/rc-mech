import {
	array,
	custom,
	nullable,
	number,
	object,
	optional,
	string,
} from 'zod/mini';
import type { WebAuthnOptions } from './passkey-credentials';

export type TimezonePreference = { timezone: string | null };

export type Passkey = {
	id: string;
	name?: string | null;
	createdAt?: string;
	aaguid?: string | null;
};

export type InviteCode = {
	id: string;
	code: string;
	status: string;
	createdAt: string;
	reservedEmail?: string | null;
	reservedUntil?: string | null;
};

export type InviteCodesResponse = {
	allowance: number;
	used: number;
	remaining: number;
	codes: InviteCode[];
};

export const inviteCodeSchema = object({
	id: string(),
	code: string(),
	status: string(),
	createdAt: string(),
	reservedEmail: optional(nullable(string())),
	reservedUntil: optional(nullable(string())),
});

export const inviteCodesSchema = object({
	allowance: number(),
	used: number(),
	remaining: number(),
	codes: array(inviteCodeSchema),
});

export const inviteMutationSchema = object({ code: inviteCodeSchema });

export const passkeySchema = object({
	id: string(),
	name: optional(nullable(string())),
	createdAt: optional(string()),
	aaguid: optional(nullable(string())),
});

export const passkeyCollectionSchema = array(passkeySchema);

export const webAuthnOptionsSchema = custom<WebAuthnOptions>(
	(value) =>
		typeof value === 'object' &&
		value !== null &&
		'challenge' in value &&
		typeof value.challenge === 'string',
);

export const acknowledgedMutationSchema = object({});

export type SettingsGatewayFailure =
	| {
			readonly kind: 'http';
			readonly status: number;
			readonly message?: string;
	  }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

export const defaultTimezone = (): string => {
	try {
		const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
		if (!timezone) return 'UTC';
		return timezone;
	} catch {
		return 'UTC';
	}
};

export const isValidTimezone = (value: string): boolean => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return value.includes('/') || value === 'UTC';
	} catch {
		return false;
	}
};
