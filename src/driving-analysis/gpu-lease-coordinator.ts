import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

export const GPU_LEASE_DURATION_MS = 90_000;
export const GPU_COMMIT_HOLD_DURATION_MS = 30_000;
export const GPU_MAX_QUEUE_SIZE = 10_000;
export const GPU_MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const GPU_LEASE_COORDINATOR_OBJECT_NAME = 'rtx-3090';

export const getGpuLeaseCoordinator = (
	env: Pick<Env, 'GPU_LEASE_COORDINATOR'>,
): DurableObjectStub<GpuLeaseCoordinator> =>
	env.GPU_LEASE_COORDINATOR.getByName(GPU_LEASE_COORDINATOR_OBJECT_NAME);

const segmentId = z.string().trim().min(1).max(160);
const leaseId = z.string().uuid();
const fence = z.number().int().positive();

export const gpuLeaseEnqueueInput = z
	.object({
		segmentId,
		deadlineAt: z.number().int().positive(),
		kind: z.enum(['initial', 'reidentification']),
	})
	.strict()
	.refine(
		(value) =>
			value.deadlineAt >= Date.now() &&
			value.deadlineAt <= Date.now() + GPU_MAX_DEADLINE_MS,
		'Deadline must be current and within the coordinator maximum',
	);

export const gpuLeaseAcquireInput = z
	.object({ now: z.number().int().nonnegative().optional() })
	.strict()
	.default({});

export const gpuLeaseWitnessInput = z
	.object({ segmentId, leaseId, fence })
	.strict();

export const gpuLeaseRenewInput = gpuLeaseWitnessInput.extend({
	now: z.number().int().nonnegative().optional(),
});

export const gpuLeaseReleaseInput = gpuLeaseWitnessInput.extend({
	completed: z.boolean().optional(),
});

export const gpuLeaseCancelInput = z
	.object({ segmentId, leaseId: leaseId.optional(), fence: fence.optional() })
	.strict()
	.refine(
		(value) => (value.leaseId === undefined) === (value.fence === undefined),
		'Lease and fence must be supplied together',
	);

export const gpuLeaseBusyInput = gpuLeaseWitnessInput.extend({
	now: z.number().int().nonnegative().optional(),
});

export const gpuLeaseHoldInput = gpuLeaseWitnessInput.extend({
	now: z.number().int().nonnegative().optional(),
});

export const gpuLeaseHoldReleaseInput = gpuLeaseWitnessInput.extend({
	holdId: z.string().uuid(),
	now: z.number().int().nonnegative().optional(),
});

export type GpuLeaseEnqueueInput = z.infer<typeof gpuLeaseEnqueueInput>;
export type GpuLeaseAcquireInput = z.infer<typeof gpuLeaseAcquireInput>;
export type GpuLeaseWitnessInput = z.infer<typeof gpuLeaseWitnessInput>;
export type GpuLeaseRenewInput = z.infer<typeof gpuLeaseRenewInput>;
export type GpuLeaseReleaseInput = z.infer<typeof gpuLeaseReleaseInput>;
export type GpuLeaseCancelInput = z.infer<typeof gpuLeaseCancelInput>;
export type GpuLeaseBusyInput = z.infer<typeof gpuLeaseBusyInput>;
export type GpuLeaseHoldInput = z.infer<typeof gpuLeaseHoldInput>;
export type GpuLeaseHoldReleaseInput = z.infer<typeof gpuLeaseHoldReleaseInput>;
export type GpuLeaseCancelMutationResult =
	| GpuLeaseCancelResult
	| { status: 'stale' };

export type GpuLeaseEnqueueResult =
	| { status: 'enqueued' }
	| { status: 'already-queued' }
	| { status: 'active' }
	| { status: 'terminal' };

export type GpuLeaseAcquireResult =
	| { status: 'busy' }
	| { status: 'empty' }
	| {
			status: 'acquired';
			segmentId: string;
			leaseId: string;
			fence: number;
			expiresAt: number;
	  };

export type GpuLeaseMutationResult =
	| { status: 'ok'; expiresAt?: number; holdId?: string }
	| { status: 'stale' }
	| { status: 'not-found' };

export type GpuLeaseCancelResult =
	| { status: 'cancelled' }
	| { status: 'already-cancelled' }
	| { status: 'not-found' };

type SqlRow = Record<string, ArrayBuffer | string | number | null>;
type WaiterRow = SqlRow & {
	segment_id: string;
	deadline_at: number;
	ordinal: number;
};
type LeaseRow = SqlRow & {
	segment_id: string;
	lease_id: string;
	fence: number;
	expires_at: number;
	hold_expires_at: number | null;
	deadline_at: number;
	kind: string;
	ordinal: number;
	hold_id: string | null;
};

const schema = `
CREATE TABLE IF NOT EXISTS gpu_waiters (
  segment_id TEXT PRIMARY KEY,
  deadline_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL UNIQUE
);
CREATE INDEX IF NOT EXISTS gpu_waiters_fifo ON gpu_waiters (ordinal);
CREATE TABLE IF NOT EXISTS gpu_lease (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  segment_id TEXT NOT NULL,
  lease_id TEXT NOT NULL UNIQUE,
  fence INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  hold_expires_at INTEGER,
  deadline_at INTEGER NOT NULL,
  kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  hold_id TEXT
);
CREATE TABLE IF NOT EXISTS gpu_meta (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS gpu_terminal (
  segment_id TEXT PRIMARY KEY,
  reason TEXT NOT NULL
);`;

/** The sole serialized authority for the physical GPU capacity. */
export class GpuLeaseCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.id.name !== GPU_LEASE_COORDINATOR_OBJECT_NAME) {
			throw new Error('GPU lease coordinator identity mismatch');
		}
		this.ctx.storage.sql.exec(schema);
		this.ctx.storage.sql.exec(
			"INSERT OR IGNORE INTO gpu_meta (key, value) VALUES ('next_ordinal', 0), ('fence', 0)",
		);
	}

	async enqueue(raw: GpuLeaseEnqueueInput): Promise<GpuLeaseEnqueueResult> {
		const input = gpuLeaseEnqueueInput.parse(raw);
		this.expire(Date.now());
		const terminal = this.row<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_terminal WHERE segment_id = ?',
			input.segmentId,
		);
		if (terminal) return { status: 'terminal' };
		const existing = this.row<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_waiters WHERE segment_id = ?',
			input.segmentId,
		);
		if (existing) return { status: 'already-queued' };
		const active = this.row<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_lease WHERE singleton = 1 AND segment_id = ?',
			input.segmentId,
		);
		if (active) return { status: 'active' };
		const count = this.row<{ count: number }>(
			' SELECT COUNT(*) AS count FROM gpu_waiters',
		);
		if ((count?.count ?? 0) >= GPU_MAX_QUEUE_SIZE) {
			throw new Error('GPU lease queue is full');
		}
		const ordinal = this.next('next_ordinal');
		this.ctx.storage.sql.exec(
			'INSERT INTO gpu_waiters (segment_id, deadline_at, kind, ordinal) VALUES (?, ?, ?, ?)',
			input.segmentId,
			input.deadlineAt,
			input.kind,
			ordinal,
		);
		await this.scheduleAlarm();
		return { status: 'enqueued' };
	}

	async acquire(
		raw: GpuLeaseAcquireInput = {},
	): Promise<GpuLeaseAcquireResult> {
		const { now: requestedNow } = gpuLeaseAcquireInput.parse(raw);
		const now = this.clock(requestedNow);
		this.expire(now);
		if (this.row(' SELECT singleton FROM gpu_lease WHERE singleton = 1')) {
			return { status: 'busy' };
		}
		const waiter = this.row<WaiterRow>(
			' SELECT segment_id, deadline_at, ordinal FROM gpu_waiters ORDER BY ordinal LIMIT 1',
		);
		if (!waiter) return { status: 'empty' };
		if (waiter.deadline_at <= now) {
			this.ctx.storage.sql.exec(
				'DELETE FROM gpu_waiters WHERE segment_id = ?',
				waiter.segment_id,
			);
			this.terminal(waiter.segment_id, 'deadline-expired');
			return this.acquire({ now });
		}
		const newFence = this.next('fence');
		const newLeaseId = crypto.randomUUID();
		const expiresAt = Math.min(now + GPU_LEASE_DURATION_MS, waiter.deadline_at);
		const kind =
			this.row<{ kind: string }>(
				' SELECT kind FROM gpu_waiters WHERE segment_id = ?',
				waiter.segment_id,
			)?.kind ?? 'initial';
		this.ctx.storage.sql.exec(
			'DELETE FROM gpu_waiters WHERE segment_id = ?',
			waiter.segment_id,
		);
		this.ctx.storage.sql.exec(
			'INSERT INTO gpu_lease (singleton, segment_id, lease_id, fence, expires_at, hold_expires_at, deadline_at, kind, ordinal, hold_id) VALUES (1, ?, ?, ?, ?, NULL, ?, ?, ?, NULL)',
			waiter.segment_id,
			newLeaseId,
			newFence,
			expiresAt,
			waiter.deadline_at,
			kind,
			waiter.ordinal,
		);
		await this.scheduleAlarm();
		return {
			status: 'acquired',
			segmentId: waiter.segment_id,
			leaseId: newLeaseId,
			fence: newFence,
			expiresAt,
		};
	}

	async renew(raw: GpuLeaseRenewInput): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseRenewInput.parse(raw);
		const now = this.clock(input.now);
		this.expire(now);
		const lease = this.current(input);
		if (!lease) return { status: 'stale' };
		if (lease.hold_id !== null) return { status: 'stale' };
		if (lease.hold_expires_at !== null) return { status: 'stale' };
		const expiresAt = Math.min(now + GPU_LEASE_DURATION_MS, lease.deadline_at);
		if (expiresAt <= now) return { status: 'stale' };
		this.ctx.storage.sql.exec(
			'UPDATE gpu_lease SET expires_at = ? WHERE singleton = 1',
			expiresAt,
		);
		await this.scheduleAlarm();
		return { status: 'ok', expiresAt };
	}

	async release(raw: GpuLeaseReleaseInput): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseReleaseInput.parse(raw);
		this.expire(Date.now());
		const lease = this.current(input);
		if (!lease) return { status: 'stale' };
		this.ctx.storage.sql.exec('DELETE FROM gpu_lease WHERE singleton = 1');
		if (input.completed) this.terminal(input.segmentId, 'completed');
		await this.scheduleAlarm();
		return { status: 'ok' };
	}

	async cancel(
		raw: GpuLeaseCancelInput,
	): Promise<GpuLeaseCancelMutationResult> {
		const input = gpuLeaseCancelInput.parse(raw);
		this.expire(Date.now());
		const terminal = this.row<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_terminal WHERE segment_id = ?',
			input.segmentId,
		);
		if (terminal) return { status: 'already-cancelled' };
		const active = this.row<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_lease WHERE singleton = 1 AND segment_id = ?',
			input.segmentId,
		);
		if (active) {
			if (
				input.leaseId === undefined ||
				input.fence === undefined ||
				!this.current({
					segmentId: input.segmentId,
					leaseId: input.leaseId,
					fence: input.fence,
				})
			)
				return { status: 'stale' };
			this.ctx.storage.sql.exec('DELETE FROM gpu_lease WHERE singleton = 1');
		} else {
			if (input.leaseId !== undefined || input.fence !== undefined) {
				return { status: 'stale' };
			}
			this.ctx.storage.sql.exec(
				'DELETE FROM gpu_waiters WHERE segment_id = ?',
				input.segmentId,
			);
			if (this.changes() === 0) return { status: 'not-found' };
		}
		this.terminal(input.segmentId, 'cancelled');
		await this.scheduleAlarm();
		return { status: 'cancelled' };
	}

	async restoreCapacityBusy(
		raw: GpuLeaseBusyInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseBusyInput.parse(raw);
		this.expire(this.clock(input.now));
		const lease = this.current(input);
		if (!lease) return { status: 'stale' };
		const waiter = this.row<WaiterRow>(
			' SELECT segment_id, deadline_at, ordinal FROM gpu_waiters WHERE segment_id = ?',
			input.segmentId,
		);
		this.ctx.storage.sql.exec('DELETE FROM gpu_lease WHERE singleton = 1');
		if (
			!waiter &&
			!this.row(
				' SELECT segment_id FROM gpu_terminal WHERE segment_id = ?',
				input.segmentId,
			)
		) {
			this.ctx.storage.sql.exec(
				'INSERT INTO gpu_waiters (segment_id, deadline_at, kind, ordinal) VALUES (?, ?, ?, ?)',
				input.segmentId,
				lease.deadline_at,
				lease.kind,
				lease.ordinal,
			);
		}
		await this.scheduleAlarm();
		return { status: 'ok' };
	}

	async beginCommitHold(
		raw: GpuLeaseHoldInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseHoldInput.parse(raw);
		const now = this.clock(input.now);
		this.expire(now);
		const lease = this.current(input);
		if (!lease) return { status: 'stale' };
		if (lease.hold_id !== null) return { status: 'stale' };
		const holdExpiresAt = Math.min(
			now + GPU_COMMIT_HOLD_DURATION_MS,
			lease.deadline_at,
		);
		if (holdExpiresAt <= now) return { status: 'stale' };
		const holdId = crypto.randomUUID();
		this.ctx.storage.sql.exec(
			'UPDATE gpu_lease SET hold_expires_at = ?, expires_at = ?, hold_id = ? WHERE singleton = 1',
			holdExpiresAt,
			holdExpiresAt,
			holdId,
		);
		await this.scheduleAlarm();
		return { status: 'ok', expiresAt: holdExpiresAt, holdId };
	}

	async releaseCommitHold(
		raw: GpuLeaseHoldReleaseInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseHoldReleaseInput.parse(raw);
		this.expire(this.clock(input.now));
		const lease = this.current(input);
		if (!lease || lease.hold_id !== input.holdId) return { status: 'stale' };
		this.ctx.storage.sql.exec(
			'UPDATE gpu_lease SET hold_expires_at = NULL, hold_id = NULL WHERE singleton = 1',
		);
		await this.scheduleAlarm();
		return { status: 'ok' };
	}

	async alarm(): Promise<void> {
		const now = Date.now();
		this.expire(now);
		this.expireWaiters(now);
		await this.scheduleAlarm();
	}

	private expireWaiters(now: number): void {
		const expired = this.ctx.storage.sql.exec<{ segment_id: string }>(
			' SELECT segment_id FROM gpu_waiters WHERE deadline_at <= ? ORDER BY ordinal',
			now,
		);
		for (const waiter of expired) {
			this.ctx.storage.sql.exec(
				'DELETE FROM gpu_waiters WHERE segment_id = ?',
				waiter.segment_id,
			);
			this.terminal(waiter.segment_id, 'deadline-expired');
		}
	}

	private expire(now: number): void {
		const lease = this.row<LeaseRow>(
			' SELECT segment_id, lease_id, fence, expires_at, hold_expires_at, deadline_at, kind, ordinal, hold_id FROM gpu_lease WHERE singleton = 1',
		);
		if (!lease) return;
		if (lease.hold_expires_at !== null && lease.hold_expires_at <= now) {
			this.ctx.storage.sql.exec(
				'UPDATE gpu_lease SET hold_expires_at = NULL, hold_id = NULL WHERE singleton = 1',
			);
			lease.hold_expires_at = null;
		}
		if (lease.expires_at > now) return;
		const terminal = this.row(
			' SELECT segment_id FROM gpu_terminal WHERE segment_id = ?',
			lease.segment_id,
		);
		this.ctx.storage.sql.exec('DELETE FROM gpu_lease WHERE singleton = 1');
		if (!terminal) {
			const waiter = this.row(
				' SELECT segment_id FROM gpu_waiters WHERE segment_id = ?',
				lease.segment_id,
			);
			if (!waiter) {
				this.ctx.storage.sql.exec(
					'INSERT INTO gpu_waiters (segment_id, deadline_at, kind, ordinal) VALUES (?, ?, ?, ?)',
					lease.segment_id,
					lease.deadline_at,
					lease.kind,
					lease.ordinal,
				);
			}
		}
	}

	private current(input: GpuLeaseWitnessInput): LeaseRow | undefined {
		return this.row<LeaseRow>(
			' SELECT segment_id, lease_id, fence, expires_at, hold_expires_at, deadline_at, kind, ordinal, hold_id FROM gpu_lease WHERE singleton = 1 AND segment_id = ? AND lease_id = ? AND fence = ?',
			input.segmentId,
			input.leaseId,
			input.fence,
		);
	}

	private terminal(segmentIdValue: string, reason: string): void {
		this.ctx.storage.sql.exec(
			'INSERT OR IGNORE INTO gpu_terminal (segment_id, reason) VALUES (?, ?)',
			segmentIdValue,
			reason,
		);
	}

	private next(key: string): number {
		const row = this.row<{ value: number }>(
			' SELECT value FROM gpu_meta WHERE key = ?',
			key,
		);
		const value = (row?.value ?? 0) + 1;
		this.ctx.storage.sql.exec(
			'UPDATE gpu_meta SET value = ? WHERE key = ?',
			value,
			key,
		);
		return value;
	}

	private clock(testTime: number | undefined): number {
		return this.env.ENVIRONMENT === 'local' && testTime !== undefined
			? testTime
			: Date.now();
	}

	private row<T extends SqlRow>(
		query: string,
		...bindings: Array<string | number>
	): T | undefined {
		const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
		const result = cursor.next();
		return result.done ? undefined : result.value;
	}

	private changes(): number {
		return this.ctx.storage.sql
			.exec<{ changes: number }>(' SELECT changes() AS changes')
			.one().changes;
	}

	private async scheduleAlarm(): Promise<void> {
		const lease = this.row<{
			expires_at: number;
			hold_expires_at: number | null;
		}>(
			' SELECT expires_at, hold_expires_at FROM gpu_lease WHERE singleton = 1',
		);
		const waiter = this.row<{ deadline_at: number }>(
			' SELECT deadline_at FROM gpu_waiters ORDER BY ordinal LIMIT 1',
		);
		const candidates = [
			lease?.expires_at,
			lease?.hold_expires_at ?? undefined,
			waiter?.deadline_at,
		].filter((value): value is number => value !== undefined);
		if (candidates.length === 0) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.min(...candidates));
	}
}
