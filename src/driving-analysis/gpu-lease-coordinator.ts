import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';

export const GPU_LEASE_DURATION_MS = 90_000;
export const GPU_COMMIT_HOLD_DURATION_MS = 30_000;
export const GPU_MAX_QUEUE_SIZE = 10_000;
export const GPU_MAX_DEADLINE_MS = 24 * 60 * 60 * 1000;
export const GPU_LEASE_COORDINATOR_OBJECT_NAME = 'rtx-3090';
export const GPU_LEASE_COORDINATOR_STORAGE_KEY = 'gpu-lease-coordinator/state';

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
export type GpuLeaseCancelMutationResult =
	| GpuLeaseCancelResult
	| { status: 'stale' };

type WorkKind = 'initial' | 'reidentification';
type TerminalReason = 'cancelled' | 'completed' | 'deadline-expired';
type Waiter = {
	segmentId: string;
	deadlineAt: number;
	kind: WorkKind;
	ordinal: number;
};
type Lease = Waiter & {
	leaseId: string;
	fence: number;
	expiresAt: number;
	holdExpiresAt: number | null;
	holdId: string | null;
};
export type PersistedGpuLeaseState = {
	nextOrdinal: number;
	fence: number;
	waiters: Waiter[];
	activeLease: Lease | null;
	terminal: Record<string, TerminalReason>;
};

const emptyState = (): PersistedGpuLeaseState => ({
	nextOrdinal: 0,
	fence: 0,
	waiters: [],
	activeLease: null,
	terminal: {},
});

/** The sole serialized authority for the physical GPU capacity. */
export class GpuLeaseCoordinator extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		if (ctx.id.name !== GPU_LEASE_COORDINATOR_OBJECT_NAME)
			throw new Error('GPU lease coordinator identity mismatch');
	}

	async enqueue(raw: GpuLeaseEnqueueInput): Promise<GpuLeaseEnqueueResult> {
		const input = gpuLeaseEnqueueInput.parse(raw);
		const result = await this.mutate((state) => {
			this.expire(state, Date.now());
			if (state.terminal[input.segmentId])
				return { status: 'terminal' } as const;
			if (state.waiters.some((waiter) => waiter.segmentId === input.segmentId))
				return { status: 'already-queued' } as const;
			if (state.activeLease?.segmentId === input.segmentId)
				return { status: 'active' } as const;
			if (state.waiters.length >= GPU_MAX_QUEUE_SIZE)
				throw new Error('GPU lease queue is full');
			state.nextOrdinal += 1;
			state.waiters.push({ ...input, ordinal: state.nextOrdinal });
			return { status: 'enqueued' } as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async acquire(
		raw: GpuLeaseAcquireInput = {},
	): Promise<GpuLeaseAcquireResult> {
		const { now: requestedNow } = gpuLeaseAcquireInput.parse(raw);
		const now = this.clock(requestedNow);
		const result = await this.mutate<GpuLeaseAcquireResult>((state) => {
			this.expire(state, now);
			if (state.activeLease) return { status: 'busy' };
			while (state.waiters.length > 0) {
				state.waiters.sort((a, b) => a.ordinal - b.ordinal);
				const waiter = state.waiters[0];
				if (waiter.deadlineAt <= now) {
					state.waiters.shift();
					this.markTerminal(state, waiter.segmentId, 'deadline-expired');
					continue;
				}
				state.waiters.shift();
				state.fence += 1;
				const expiresAt = Math.min(
					now + GPU_LEASE_DURATION_MS,
					waiter.deadlineAt,
				);
				const lease: Lease = {
					...waiter,
					leaseId: crypto.randomUUID(),
					fence: state.fence,
					expiresAt,
					holdExpiresAt: null,
					holdId: null,
				};
				state.activeLease = lease;
				return {
					status: 'acquired',
					segmentId: lease.segmentId,
					leaseId: lease.leaseId,
					fence: lease.fence,
					expiresAt,
				};
			}
			return { status: 'empty' };
		});
		await this.scheduleAlarm();
		return result;
	}

	async renew(raw: GpuLeaseRenewInput): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseRenewInput.parse(raw);
		const now = this.clock(input.now);
		const result = await this.mutate((state) => {
			this.expire(state, now);
			const lease = this.current(state, input);
			if (!lease || lease.holdId !== null || lease.holdExpiresAt !== null)
				return { status: 'stale' } as const;
			const expiresAt = Math.min(now + GPU_LEASE_DURATION_MS, lease.deadlineAt);
			if (expiresAt <= now) return { status: 'stale' } as const;
			lease.expiresAt = expiresAt;
			return { status: 'ok', expiresAt } as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async release(raw: GpuLeaseReleaseInput): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseReleaseInput.parse(raw);
		const result = await this.mutate((state) => {
			this.expire(state, Date.now());
			if (!this.current(state, input)) return { status: 'stale' } as const;
			state.activeLease = null;
			if (input.completed)
				this.markTerminal(state, input.segmentId, 'completed');
			return { status: 'ok' } as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async cancel(
		raw: GpuLeaseCancelInput,
	): Promise<GpuLeaseCancelMutationResult> {
		const input = gpuLeaseCancelInput.parse(raw);
		const result = await this.mutate<GpuLeaseCancelMutationResult>((state) => {
			this.expire(state, Date.now());
			if (state.terminal[input.segmentId])
				return { status: 'already-cancelled' };
			if (state.activeLease?.segmentId === input.segmentId) {
				if (
					input.leaseId === undefined ||
					input.fence === undefined ||
					!this.current(state, {
						segmentId: input.segmentId,
						leaseId: input.leaseId,
						fence: input.fence,
					})
				)
					return { status: 'stale' };
				state.activeLease = null;
			} else {
				if (input.leaseId !== undefined || input.fence !== undefined)
					return { status: 'stale' };
				const before = state.waiters.length;
				state.waiters = state.waiters.filter(
					(waiter) => waiter.segmentId !== input.segmentId,
				);
				if (state.waiters.length === before) return { status: 'not-found' };
			}
			this.markTerminal(state, input.segmentId, 'cancelled');
			return { status: 'cancelled' };
		});
		await this.scheduleAlarm();
		return result;
	}

	async restoreCapacityBusy(
		raw: GpuLeaseBusyInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseBusyInput.parse(raw);
		const now = this.clock(input.now);
		const result = await this.mutate((state) => {
			this.expire(state, now);
			const lease = this.current(state, input);
			if (!lease) return { status: 'stale' } as const;
			const alreadyQueued = state.waiters.some(
				(waiter) => waiter.segmentId === input.segmentId,
			);
			if (
				!alreadyQueued &&
				!state.terminal[input.segmentId] &&
				state.waiters.length >= GPU_MAX_QUEUE_SIZE
			)
				throw new Error('GPU lease queue is full');
			state.activeLease = null;
			if (!alreadyQueued && !state.terminal[input.segmentId])
				state.waiters.push({
					segmentId: lease.segmentId,
					deadlineAt: lease.deadlineAt,
					kind: lease.kind,
					ordinal: lease.ordinal,
				});
			return { status: 'ok' } as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async beginCommitHold(
		raw: GpuLeaseHoldInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseHoldInput.parse(raw);
		const now = this.clock(input.now);
		const result = await this.mutate((state) => {
			this.expire(state, now);
			const lease = this.current(state, input);
			if (!lease || lease.holdId !== null) return { status: 'stale' } as const;
			const holdExpiresAt = Math.min(
				now + GPU_COMMIT_HOLD_DURATION_MS,
				lease.deadlineAt,
			);
			if (holdExpiresAt <= now) return { status: 'stale' } as const;
			lease.holdExpiresAt = holdExpiresAt;
			lease.expiresAt = holdExpiresAt;
			lease.holdId = crypto.randomUUID();
			return {
				status: 'ok',
				expiresAt: holdExpiresAt,
				holdId: lease.holdId,
			} as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async releaseCommitHold(
		raw: GpuLeaseHoldReleaseInput,
	): Promise<GpuLeaseMutationResult> {
		const input = gpuLeaseHoldReleaseInput.parse(raw);
		const result = await this.mutate((state) => {
			this.expire(state, this.clock(input.now));
			const lease = this.current(state, input);
			if (!lease || lease.holdId !== input.holdId)
				return { status: 'stale' } as const;
			lease.holdId = null;
			lease.holdExpiresAt = null;
			return { status: 'ok' } as const;
		});
		await this.scheduleAlarm();
		return result;
	}

	async alarm(): Promise<void> {
		await this.mutate((state) => {
			this.expire(state, Date.now());
		});
		await this.scheduleAlarm();
	}

	private async mutate<T>(
		mutator: (state: PersistedGpuLeaseState) => T,
	): Promise<T> {
		return this.ctx.storage.transaction(async (transaction) => {
			const state =
				(await transaction.get<PersistedGpuLeaseState>(
					GPU_LEASE_COORDINATOR_STORAGE_KEY,
				)) ?? emptyState();
			const result = mutator(state);
			await transaction.put(GPU_LEASE_COORDINATOR_STORAGE_KEY, state);
			return result;
		});
	}

	private expire(state: PersistedGpuLeaseState, now: number): void {
		state.waiters = state.waiters.filter((waiter) => {
			if (waiter.deadlineAt > now) return true;
			this.markTerminal(state, waiter.segmentId, 'deadline-expired');
			return false;
		});
		const lease = state.activeLease;
		if (!lease) return;
		if (lease.holdExpiresAt !== null && lease.holdExpiresAt <= now) {
			lease.holdExpiresAt = null;
			lease.holdId = null;
		}
		if (lease.expiresAt > now) return;
		state.activeLease = null;
		if (
			!state.terminal[lease.segmentId] &&
			!state.waiters.some((waiter) => waiter.segmentId === lease.segmentId)
		) {
			state.waiters.push({
				segmentId: lease.segmentId,
				deadlineAt: lease.deadlineAt,
				kind: lease.kind,
				ordinal: lease.ordinal,
			});
		}
	}

	private current(
		state: PersistedGpuLeaseState,
		input: GpuLeaseWitnessInput,
	): Lease | undefined {
		const lease = state.activeLease;
		return lease?.segmentId === input.segmentId &&
			lease.leaseId === input.leaseId &&
			lease.fence === input.fence
			? lease
			: undefined;
	}

	private markTerminal(
		state: PersistedGpuLeaseState,
		segmentIdValue: string,
		reason: TerminalReason,
	): void {
		state.terminal[segmentIdValue] ??= reason;
	}

	private clock(testTime: number | undefined): number {
		return this.env.ENVIRONMENT === 'local' && testTime !== undefined
			? testTime
			: Date.now();
	}

	private async scheduleAlarm(): Promise<void> {
		const state = await this.ctx.storage.get<PersistedGpuLeaseState>(
			GPU_LEASE_COORDINATOR_STORAGE_KEY,
		);
		const candidates = [
			state?.activeLease?.expiresAt,
			state?.activeLease?.holdExpiresAt ?? undefined,
			state?.waiters.sort((a, b) => a.ordinal - b.ordinal)[0]?.deadlineAt,
		].filter((value): value is number => value !== undefined);
		if (candidates.length === 0) await this.ctx.storage.deleteAlarm();
		else await this.ctx.storage.setAlarm(Math.min(...candidates));
	}
}
