/**
 * Strict Settings command contract at the Worker synchronization boundary. Rejects
 * malformed intent before receipt admission; saved base evidence travels with the
 * command so offline replay can detect conflicts instead of overwriting silently.
 */

import { z } from 'zod';

export const settingsSyncEnvelope = z.strictObject({
	contractVersion: z.literal(1),
	command: z.discriminatedUnion('type', [
		z.strictObject({
			type: z.literal('timezone'),
			base: z.string(),
			timezone: z.string(),
		}),
		z.strictObject({ type: z.literal('invite-create'), code: z.string() }),
		z.strictObject({ type: z.literal('invite-revoke'), inviteId: z.uuid() }),
	]),
});
