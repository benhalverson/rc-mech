import { and, eq, exists, getTableColumns, type SQL } from 'drizzle-orm';
import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db';
import { isIanaTimezone } from '../drive-session-policy';
import { validateInviteCode } from '../invite-policy';
import { inviteCode, owner, syncOperation } from '../schema';
import { settingsSyncEnvelope } from '../settings-sync-contract';
import type { AppEnv } from '../types';
import {
	pendingSyncReceipt,
	syncInsertSelection,
} from './pending-sync-receipt';

export const createSettingsSyncRoutes = () => {
	const routes = new Hono<AppEnv>();
	routes.onError(
		() =>
			new Response(
				JSON.stringify({
					error: 'Settings synchronization is temporarily unavailable.',
				}),
				{ status: 503, headers: { 'content-type': 'application/json' } },
			),
	);
	routes.put('/settings/sync/operations/:operationId', async (c) => {
		const id = z.uuid().safeParse(c.req.param('operationId'));
		const parsed = settingsSyncEnvelope.safeParse(
			await c.req.json().catch(() => null),
		);
		if (!id.success || !parsed.success)
			return c.json({ error: 'Invalid Settings operation.' }, 400);
		const operationId = id.data;
		const ownerId = c.get('userId');
		const database = db(c.env);
		const now = new Date().toISOString();
		const command = parsed.data.command;
		const digest = await crypto.subtle.digest(
			'SHA-256',
			new TextEncoder().encode(JSON.stringify(parsed.data)),
		);
		const requestHash = [...new Uint8Array(digest)]
			.map((byte) => byte.toString(16).padStart(2, '0'))
			.join('');
		const receiptPending = pendingSyncReceipt(
			database,
			ownerId,
			operationId,
			requestHash,
		);
		const identity = and(
			eq(syncOperation.ownerId, ownerId),
			eq(syncOperation.operationId, operationId),
		);
		const read = () =>
			database.select().from(syncOperation).where(identity).get();
		const replay = (receipt: typeof syncOperation.$inferSelect | undefined) => {
			if (!receipt || receipt.outcome === 'pending')
				throw new Error('Settings operation has no terminal receipt.');
			if (receipt.responseJson === null || receipt.httpStatus === null)
				throw new Error('Incomplete Settings receipt.');
			return new Response(receipt.responseJson, {
				status: receipt.httpStatus,
				headers: { 'content-type': 'application/json' },
			});
		};
		const claimed = await database
			.insert(syncOperation)
			.values({
				ownerId,
				operationId,
				contractVersion: 1,
				kind: 'settings.change',
				entityType: 'settings',
				entityId: ownerId,
				requestHash,
				outcome: 'pending',
				createdAt: now,
			})
			.onConflictDoNothing()
			.returning()
			.get();
		const receipt = claimed ?? (await read());
		if (!receipt)
			return c.json({ error: 'Settings operation is being applied.' }, 503);
		if (receipt.requestHash !== requestHash)
			return c.json(
				{ error: 'Operation ID was already used for another request.' },
				409,
			);
		if (receipt.outcome !== 'pending') return replay(receipt);
		const terminal = (
			outcome: 'applied' | 'rejected' | 'conflict',
			body: Readonly<Record<string, unknown>>,
			witness?: SQL,
		) =>
			database
				.update(syncOperation)
				.set({
					outcome,
					httpStatus: outcome === 'applied' ? 200 : 409,
					responseJson: JSON.stringify({ operationId, outcome, ...body }),
					completedAt: now,
				})
				.where(
					and(
						identity,
						eq(syncOperation.requestHash, requestHash),
						eq(syncOperation.outcome, 'pending'),
						witness,
					),
				);
		const reject = async (message: string) => {
			await terminal('rejected', { error: message }).run();
			return replay(await read());
		};
		if (command.type === 'timezone') {
			if (!isIanaTimezone(command.timezone) || !isIanaTimezone(command.base))
				return reject('Use a valid IANA timezone.');
			const current = await database
				.select({ timezone: owner.timezone })
				.from(owner)
				.where(eq(owner.id, ownerId))
				.get();
			if (!current) return reject('Settings owner is unavailable.');
			if (
				current.timezone !== command.base &&
				current.timezone !== command.timezone
			) {
				await terminal('conflict', {
					error: 'The timezone changed on another device.',
					remote: current.timezone,
				}).run();
				return replay(await read());
			}
			await database.batch([
				database
					.update(owner)
					.set({ timezone: command.timezone })
					.where(
						and(
							eq(owner.id, ownerId),
							eq(owner.timezone, current.timezone),
							receiptPending,
						),
					),
				terminal(
					'applied',
					{ timezone: command.timezone },
					exists(
						database
							.select({ id: owner.id })
							.from(owner)
							.where(
								and(
									eq(owner.id, ownerId),
									eq(owner.timezone, command.timezone),
								),
							),
					),
				),
			]);
			const result = await read();
			if (result?.outcome === 'pending') {
				const remote = await database
					.select({ timezone: owner.timezone })
					.from(owner)
					.where(eq(owner.id, ownerId))
					.get();
				await terminal('conflict', {
					error: 'The timezone changed on another device.',
					remote: remote?.timezone ?? command.base,
				}).run();
				return replay(await read());
			}
			return replay(result);
		}
		if (command.type === 'invite-create') {
			const code = validateInviteCode(command.code);
			if (code.ok === false) return reject(code.reason);
			const inserts = [1, 2, 3, 4, 5].map((slot) =>
				database
					.insert(inviteCode)
					.select(
						database
							.select(
								syncInsertSelection(
									{
										id: operationId,
										code: code.code,
										creatorId: ownerId,
										slot,
										status: 'available',
										reservedEmail: null,
										reservedUntil: null,
										redeemedEmail: null,
										redeemedUserId: null,
										reservedAt: null,
										redeemedAt: null,
										revokedAt: null,
										createdAt: now,
										updatedAt: now,
									},
									getTableColumns(inviteCode),
								),
							)
							.from(owner)
							.where(and(eq(owner.id, ownerId), receiptPending)),
					)
					.onConflictDoNothing(),
			);
			await database.batch([
				inserts[0],
				...inserts.slice(1),
				terminal(
					'applied',
					{
						invite: {
							id: operationId,
							code: code.code,
							status: 'available',
							createdAt: now,
						},
					},
					exists(
						database
							.select({ id: inviteCode.id })
							.from(inviteCode)
							.where(
								and(
									eq(inviteCode.id, operationId),
									eq(inviteCode.creatorId, ownerId),
									eq(inviteCode.code, code.code),
								),
							),
					),
				),
				terminal('rejected', {
					error:
						'The invite-code allowance is exhausted or that code is already in use.',
				}),
			]);
			return replay(await read());
		}
		await database.batch([
			database
				.update(inviteCode)
				.set({
					status: 'revoked',
					revokedAt: now,
					reservedEmail: null,
					reservedUntil: null,
					updatedAt: now,
				})
				.where(
					and(
						eq(inviteCode.id, command.inviteId),
						eq(inviteCode.creatorId, ownerId),
						eq(inviteCode.status, 'available'),
						receiptPending,
					),
				),
			terminal(
				'applied',
				{ revokedInviteId: command.inviteId },
				exists(
					database
						.select({ id: inviteCode.id })
						.from(inviteCode)
						.where(
							and(
								eq(inviteCode.id, command.inviteId),
								eq(inviteCode.creatorId, ownerId),
								eq(inviteCode.status, 'revoked'),
							),
						),
				),
			),
			terminal('rejected', {
				error: 'Invite code not found or cannot be revoked.',
			}),
		]);
		return replay(await read());
	});
	return routes;
};
