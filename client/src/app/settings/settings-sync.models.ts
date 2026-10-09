import { literal, object, optional, string, union } from 'zod/mini';
import {
	type InviteCodesResponse,
	inviteCodeSchema,
	inviteCodesSchema,
} from './settings.models';

export type SettingsSnapshot = Readonly<{
	timezone: string;
	invites: InviteCodesResponse;
}>;
export type SettingsCommand =
	| Readonly<{ type: 'timezone'; base: string; timezone: string }>
	| Readonly<{ type: 'invite-create'; code: string }>
	| Readonly<{ type: 'invite-revoke'; inviteId: string }>;
export type SettingsOperation = Readonly<{
	operationId: string;
	ownerKey: string;
	createdAt: string;
	command: SettingsCommand;
	dependencies: readonly string[];
	status: 'pending' | 'needs-attention' | 'conflict';
	feedback?: string;
	remote?: string;
}>;
export type SettingsView = Readonly<{
	canonical: SettingsSnapshot;
	current: SettingsSnapshot;
	operations: readonly SettingsOperation[];
}>;
export const settingsSnapshotSchema = object({
	timezone: string(),
	invites: inviteCodesSchema,
});
export const settingsOutcomeSchema = union([
	object({
		operationId: string(),
		outcome: literal('applied'),
		timezone: optional(string()),
		invite: optional(inviteCodeSchema),
		revokedInviteId: optional(string()),
	}),
	object({
		operationId: string(),
		outcome: literal('rejected'),
		error: string(),
	}),
	object({
		operationId: string(),
		outcome: literal('conflict'),
		error: string(),
		remote: string(),
	}),
]);
export type SettingsRemoteOutcome = import('zod/mini').infer<
	typeof settingsOutcomeSchema
>;
