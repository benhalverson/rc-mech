import { describe, expect, it } from 'vitest';
import type {
	SettingsCommand,
	SettingsOperation,
	SettingsSnapshot,
} from './settings-sync.models';
import {
	acknowledgeSettings,
	applySettingsCommand,
	readySettingsOperations,
	settingsDependencies,
	settingsView,
} from './settings-sync-rules';

const snapshot: SettingsSnapshot = {
	timezone: 'UTC',
	invites: {
		allowance: 1,
		used: 1,
		remaining: 0,
		codes: [
			{ id: 'remote', code: 'REMOTE', status: 'available', createdAt: 'today' },
		],
	},
};
const operation = (command: SettingsCommand): SettingsOperation => ({
	operationId: 'local',
	ownerKey: 'owner',
	createdAt: 'today',
	command,
	dependencies: [],
	status: 'pending',
});
describe('Settings local working copy', () => {
	it('materializes pending timezone and normalized invites while keeping canonical data intact', () => {
		const timezone = operation({
			type: 'timezone',
			base: 'UTC',
			timezone: 'Europe/London',
		});
		const invite = operation({ type: 'invite-create', code: ' track-01 ' });
		const view = settingsView(snapshot, [timezone, invite]);
		expect(view.current.timezone).toBe('Europe/London');
		expect(view.canonical).toBe(snapshot);
		expect(view.current.invites.codes[1]?.code).toBe('TRACK-01');
		expect(view.current.invites.remaining).toBe(0);
		expect(
			applySettingsCommand(view.current, invite).invites.codes,
		).toHaveLength(2);
		const revoked = applySettingsCommand(
			view.current,
			operation({ type: 'invite-revoke', inviteId: 'remote' }),
		);
		expect(revoked.invites.codes.map((code) => code.status)).toEqual([
			'revoked',
			'available',
		]);
	});
	it('waits only for the same timezone or invite dependencies and continues independent work', () => {
		const timezone = operation({
			type: 'timezone',
			base: 'UTC',
			timezone: 'Europe/London',
		});
		const create = {
			...operation({ type: 'invite-create', code: 'TRACK-01' }),
			operationId: 'invite',
		};
		const revoke = {
			...operation({ type: 'invite-revoke', inviteId: 'invite' }),
			operationId: 'revoke',
		};
		expect(settingsDependencies(timezone.command, [timezone, create])).toEqual([
			'local',
		]);
		expect(settingsDependencies(create.command, [timezone, create])).toEqual(
			[],
		);
		expect(
			settingsDependencies(revoke.command, [timezone, create, revoke]),
		).toEqual(['invite', 'revoke']);
		expect(
			readySettingsOperations([
				{ ...timezone, status: 'conflict' },
				create,
				{ ...revoke, dependencies: ['invite'] },
				{ ...revoke, operationId: 'done', dependencies: ['gone'] },
			]).map((entry) => entry.operationId),
		).toEqual(['invite', 'done']);
	});
	it('acknowledges canonical timezone and deduplicates invite history and counts', () => {
		expect(
			acknowledgeSettings(snapshot, {
				operationId: 'x',
				outcome: 'applied',
				timezone: 'Europe/London',
			}).timezone,
		).toBe('Europe/London');
		const invite = {
			id: 'local',
			code: 'LOCAL1',
			status: 'available',
			createdAt: 'today',
		};
		const response = { operationId: 'x', outcome: 'applied' as const, invite };
		const once = acknowledgeSettings(snapshot, response);
		expect(acknowledgeSettings(once, response)).toEqual(once);
		expect(
			acknowledgeSettings(once, {
				operationId: 'x',
				outcome: 'applied',
				revokedInviteId: 'local',
			}).invites.codes.map((code) => code.status),
		).toEqual(['available', 'revoked']);
	});
});
