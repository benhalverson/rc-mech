/**
 * Strict Component command contract at the Worker synchronization boundary. Rejects
 * malformed intent before receipt admission; saved base evidence travels with the
 * command so offline replay can detect conflicts instead of overwriting silently.
 */

import { z } from 'zod';
import { componentInput } from './types';

const componentBase = z
	.object({
		id: z.string().uuid(),
		carId: z.string().uuid(),
		slot: z.string(),
		slotType: z.enum(['standard', 'custom']),
		name: z.string(),
		manufacturer: z.string().nullable(),
		model: z.string().nullable(),
		serialNumber: z.string().nullable(),
		notes: z.string().nullable(),
		installedAt: z.string(),
		removedAt: z.null(),
	})
	.strict();

export const buildSyncCommandInput = z
	.object({
		type: z.literal('build.change'),
		action: z.enum(['install', 'replace', 'edit', 'remove']),
		carId: z.string().uuid(),
		componentId: z.string().uuid(),
		baseVersion: z.number().int().nonnegative(),
		base: componentBase.nullable(),
		input: componentInput.strict(),
	})
	.strict();
