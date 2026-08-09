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
