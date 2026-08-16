/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import {
	GPU_COMMIT_HOLD_DURATION_MS,
	GPU_LEASE_COORDINATOR_STORAGE_KEY,
	GPU_LEASE_DURATION_MS,
	getGpuLeaseCoordinator,
	type PersistedGpuLeaseState,
} from './gpu-lease-coordinator';

// Leave room for the local Workers runtime to boot before short test deadlines expire.
const now = Date.now() + 5 * 60_000;
const deadlineAt = now + 86_000_000;

const coordinator = () => getGpuLeaseCoordinator(env);

beforeEach(async () => {
	try {
		await runInDurableObject(coordinator(), (_instance, state) =>
			state.storage.deleteAll(),
		);
	} catch {
		// The fixed object is not running before the first test.
	}
});

afterEach(async () => {
	const stub = coordinator();
	await evictDurableObject(stub as unknown as DurableObjectStub);
});

describe('GpuLeaseCoordinator', () => {
	test('is FIFO, idempotently enqueues, and places re-identification at the tail', async () => {
		const stub = coordinator();
		expect(
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' }),
		).toEqual({ status: 'enqueued' });
		expect(
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' }),
		).toEqual({ status: 'already-queued' });
		expect(
			await stub.enqueue({
				segmentId: 'two',
				deadlineAt,
				kind: 'reidentification',
			}),
		).toEqual({ status: 'enqueued' });
		const first = await stub.acquire({ now });
		if (first.status !== 'acquired') throw new Error('expected first lease');
		expect(first.segmentId).toBe('one');
		expect(
			await stub.release({
				segmentId: first.segmentId,
				leaseId: first.leaseId,
				fence: first.fence,
			}),
		).toEqual({ status: 'ok' });
		const second = await stub.acquire({ now });
		expect(second.status).toBe('acquired');
		if (second.status === 'acquired') expect(second.segmentId).toBe('two');
	});

	test('requires current lease and fence witnesses and uses increasing fences', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		const first = await stub.acquire({ now });
		if (first.status !== 'acquired') throw new Error('expected first lease');
		expect(
			await stub.witness({
				segmentId: 'one',
				leaseId: first.leaseId,
				fence: first.fence,
				now,
			}),
		).toEqual({ status: 'ok', expiresAt: first.expiresAt });
		expect(
			await stub.witness({
				segmentId: 'one',
				leaseId: crypto.randomUUID(),
				fence: first.fence,
				now,
			}),
		).toEqual({ status: 'stale' });
		expect(
			await stub.renew({
				segmentId: 'one',
				leaseId: crypto.randomUUID(),
				fence: first.fence,
				now,
			}),
		).toEqual({ status: 'stale' });
		expect(
			await stub.release({
				segmentId: 'one',
				leaseId: first.leaseId,
				fence: first.fence,
				completed: true,
			}),
		).toEqual({ status: 'ok' });
		expect(
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' }),
		).toEqual({ status: 'terminal' });
		await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
		const second = await stub.acquire({ now: now + 1 });
		expect(second.status).toBe('acquired');
		if (second.status === 'acquired')
			expect(second.fence).toBeGreaterThan(first.fence);
	});

	test('bounds commit holds and rejects stale hold release', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		const witness = {
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
		};
		const hold = await stub.beginCommitHold({ ...witness, now });
		expect(hold.status).toBe('ok');
		if (hold.status !== 'ok' || !hold.holdId) throw new Error('expected hold');
		expect(hold.expiresAt).toBe(now + GPU_COMMIT_HOLD_DURATION_MS);
		expect(
			await stub.releaseCommitHold({ ...witness, holdId: crypto.randomUUID() }),
		).toEqual({ status: 'stale' });
		expect(
			await stub.releaseCommitHold({ ...witness, holdId: hold.holdId }),
		).toEqual({ status: 'ok' });
	});

	test('expires a commit hold and caps renewal at the original deadline', async () => {
		const stub = coordinator();
		await stub.enqueue({
			segmentId: 'one',
			deadlineAt: now + 1_000,
			kind: 'initial',
		});
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		const renewed = await stub.renew({
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
			now: now + 500,
		});
		expect(renewed).toEqual({ status: 'ok', expiresAt: now + 1_000 });
		const hold = await stub.beginCommitHold({
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
			now,
		});
		expect(hold.status).toBe('ok');
		expect(
			await stub.beginCommitHold({
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
				now: now + GPU_COMMIT_HOLD_DURATION_MS + 1,
			}),
		).toEqual({ status: 'stale' });
	});

	test('restores an expired lease at its original FIFO position across eviction', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		await evictDurableObject(stub as unknown as DurableObjectStub);
		const restarted = coordinator();
		await runInDurableObject(restarted, async (instance) => instance.alarm?.());
		const restored = await restarted.acquire({
			now: now + GPU_LEASE_DURATION_MS + 1,
		});
		expect(restored.status).toBe('acquired');
		if (restored.status === 'acquired') expect(restored.segmentId).toBe('one');
		expect(
			await restarted.cancel({
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
			}),
		).toEqual({ status: 'stale' });
	});

	test('cancellation is idempotent and removes queued work', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		expect(await stub.cancel({ segmentId: 'one' })).toEqual({
			status: 'cancelled',
		});
		expect(await stub.cancel({ segmentId: 'one' })).toEqual({
			status: 'already-cancelled',
		});
		expect(await stub.acquire({ now })).toEqual({ status: 'empty' });
	});

	test('fences active cancellation and restores a capacity-busy lease', async () => {
		const stub = coordinator();
		await stub.enqueue({
			segmentId: 'one',
			deadlineAt,
			kind: 'reidentification',
		});
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		expect(await stub.cancel({ segmentId: 'one' })).toEqual({
			status: 'stale',
		});
		expect(
			await stub.restoreCapacityBusy({
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
				now,
			}),
		).toEqual({ status: 'ok' });
		const restored = await stub.acquire({ now: now + 1 });
		expect(restored.status).toBe('acquired');
		if (restored.status !== 'acquired')
			throw new Error('expected restored lease');
		expect(restored.segmentId).toBe('one');
		expect(
			await stub.cancel({
				segmentId: restored.segmentId,
				leaseId: restored.leaseId,
				fence: restored.fence,
			}),
		).toEqual({ status: 'cancelled' });
	});

	test('renews live authority and rejects stale release and restoration', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		expect(
			await stub.renew({
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
				now: now + 1,
			}),
		).toMatchObject({ status: 'ok' });
		expect(
			await stub.release({
				segmentId: lease.segmentId,
				leaseId: crypto.randomUUID(),
				fence: lease.fence,
			}),
		).toEqual({ status: 'stale' });
		expect(
			await stub.restoreCapacityBusy({
				segmentId: lease.segmentId,
				leaseId: crypto.randomUUID(),
				fence: lease.fence,
				now: now + 1,
			}),
		).toEqual({ status: 'stale' });
	});

	test('reports busy capacity and drops expired waiters without acquiring them', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'live', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		expect(
			await stub.enqueue({ segmentId: 'live', deadlineAt, kind: 'initial' }),
		).toEqual({ status: 'active' });
		expect(await stub.acquire({ now: now + 1 })).toEqual({ status: 'busy' });
		expect(
			await stub.cancel({
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
			}),
		).toEqual({ status: 'cancelled' });
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put<PersistedGpuLeaseState>(
				GPU_LEASE_COORDINATOR_STORAGE_KEY,
				{
					nextOrdinal: 1,
					fence: 0,
					waiters: [
						{
							segmentId: 'expired',
							deadlineAt: now - 1,
							kind: 'initial',
							ordinal: 1,
						},
					],
					activeLease: null,
					terminal: {},
				},
			);
		});
		expect(await stub.acquire({ now })).toEqual({ status: 'empty' });
	});

	test('alarm expires persisted waiters', async () => {
		const stub = coordinator();
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put<PersistedGpuLeaseState>(
				GPU_LEASE_COORDINATOR_STORAGE_KEY,
				{
					nextOrdinal: 1,
					fence: 0,
					waiters: [
						{
							segmentId: 'expired',
							deadlineAt: now - 1,
							kind: 'initial',
							ordinal: 1,
						},
					],
					activeLease: null,
					terminal: {},
				},
			);
		});
		await runInDurableObject(stub, async (instance) => instance.alarm?.());
		expect(await stub.acquire({ now })).toEqual({ status: 'empty' });
	});

	test('serializes concurrent acquire calls', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
		const results = await Promise.all([
			stub.acquire({ now }),
			stub.acquire({ now }),
		]);
		expect(
			results.filter((result) => result.status === 'acquired'),
		).toHaveLength(1);
		expect(results.filter((result) => result.status === 'busy')).toHaveLength(
			1,
		);
	});

	test('bounds persisted queue growth', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'seed', deadlineAt, kind: 'initial' });
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put<PersistedGpuLeaseState>(
				GPU_LEASE_COORDINATOR_STORAGE_KEY,
				{
					nextOrdinal: 10_000,
					fence: 0,
					waiters: Array.from({ length: 10_000 }, (_, index) => ({
						segmentId: index === 0 ? 'seed' : `seed-${index}`,
						deadlineAt,
						kind: 'initial' as const,
						ordinal: index + 1,
					})),
					activeLease: null,
					terminal: {},
				},
			);
		});
		const rejected = await runInDurableObject(stub, async (instance) => {
			try {
				await instance.enqueue({
					segmentId: 'overflow',
					deadlineAt,
					kind: 'initial',
				});
				return false;
			} catch (error) {
				expect(error).toHaveProperty('message', 'GPU lease queue is full');
				return true;
			}
		});
		expect(rejected).toBe(true);
	}, 30_000);
});
