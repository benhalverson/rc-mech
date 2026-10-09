import type {
	SettingsCommand,
	SettingsOperation,
	SettingsRemoteOutcome,
	SettingsSnapshot,
	SettingsView,
} from './settings-sync.models';

export const applySettingsCommand = (
	current: SettingsSnapshot,
	operation: SettingsOperation,
): SettingsSnapshot => {
	const command = operation.command;
	if (command.type === 'timezone')
		return { ...current, timezone: command.timezone };
	const codes =
		command.type === 'invite-create'
			? [
					...current.invites.codes.filter(
						(code) => code.id !== operation.operationId,
					),
					{
						id: operation.operationId,
						code: command.code.trim().toUpperCase(),
						status: 'available',
						createdAt: operation.createdAt,
					},
				]
			: current.invites.codes.map((code) =>
					code.id === command.inviteId ? { ...code, status: 'revoked' } : code,
				);
	return {
		...current,
		invites: {
			...current.invites,
			codes,
			used: codes.length,
			remaining: Math.max(0, current.invites.allowance - codes.length),
		},
	};
};
export const settingsView = (
	canonical: SettingsSnapshot,
	operations: readonly SettingsOperation[],
): SettingsView => ({
	canonical,
	operations,
	current: operations.reduce(applySettingsCommand, canonical),
});
export const settingsDependencies = (
	command: SettingsCommand,
	operations: readonly SettingsOperation[],
): readonly string[] =>
	operations
		.filter((operation) =>
			command.type === 'timezone'
				? operation.command.type === 'timezone'
				: command.type === 'invite-revoke' &&
					(operation.operationId === command.inviteId ||
						(operation.command.type === 'invite-revoke' &&
							operation.command.inviteId === command.inviteId)),
		)
		.map((operation) => operation.operationId);
export const readySettingsOperations = (
	operations: readonly SettingsOperation[],
): readonly SettingsOperation[] => {
	const ids = new Set(operations.map((operation) => operation.operationId));
	return operations.filter(
		(operation) =>
			operation.status === 'pending' &&
			operation.dependencies.every((id) => !ids.has(id)),
	);
};
export const acknowledgeSettings = (
	canonical: SettingsSnapshot,
	outcome: Extract<SettingsRemoteOutcome, { outcome: 'applied' }>,
): SettingsSnapshot => {
	if (outcome.timezone !== undefined)
		return { ...canonical, timezone: outcome.timezone };
	const codes = outcome.invite
		? [
				...canonical.invites.codes.filter(
					(code) => code.id !== outcome.invite?.id,
				),
				outcome.invite,
			]
		: canonical.invites.codes.map((code) =>
				code.id === outcome.revokedInviteId
					? { ...code, status: 'revoked' }
					: code,
			);
	return {
		...canonical,
		invites: {
			...canonical.invites,
			codes,
			used: codes.length,
			remaining: Math.max(0, canonical.invites.allowance - codes.length),
		},
	};
};
