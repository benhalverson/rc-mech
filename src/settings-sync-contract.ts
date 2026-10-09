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
