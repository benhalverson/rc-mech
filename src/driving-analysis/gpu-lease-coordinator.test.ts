/// <reference types="@cloudflare/vitest-pool-workers/types" />
import { env, evictDurableObject, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import {
	GPU_COMMIT_HOLD_DURATION_MS,
	GPU_LEASE_COORDINATOR_STORAGE_KEY,
	GPU_LEASE_DURATION_MS,
	GpuLeaseCoordinator,
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
	test('rejects a coordinator with a different capacity identity', async () => {
		await runInDurableObject(coordinator(), (_instance, state) => {
			const identity = vi
				.spyOn(state, 'id', 'get')
				.mockReturnValue(
					env.GPU_LEASE_COORDINATOR.idFromName('wrong-capacity'),
				);
			try {
				expect(() => new GpuLeaseCoordinator(state, env)).toThrow(
					'GPU lease coordinator identity mismatch',
				);
			} finally {
				identity.mockRestore();
			}
		});
	});

	test('handles absent cancellation and expires a lease past its availability deadline', async () => {
		const stub = coordinator();
		expect(await stub.acquire()).toEqual({ status: 'empty' });
		expect(await stub.cancel({ segmentId: 'missing' })).toEqual({
			status: 'not-found',
		});
		expect(
			await stub.cancel({
				segmentId: 'missing',
				leaseId: crypto.randomUUID(),
				fence: 1,
			}),
		).toEqual({ status: 'stale' });
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		expect(await stub.acquire({ now })).toMatchObject({ status: 'acquired' });
		expect(await stub.acquire({ now: deadlineAt + 1 })).toEqual({
			status: 'empty',
		});
		expect(
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' }),
		).toEqual({ status: 'terminal' });
	});

	test('refuses renewal and commit holds beyond a persisted deadline', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		await runInDurableObject(stub, async (_instance, state) => {
			const stored = await state.storage.get<PersistedGpuLeaseState>(
				GPU_LEASE_COORDINATOR_STORAGE_KEY,
			);
			if (!stored?.activeLease) throw new Error('expected persisted lease');
			stored.activeLease.deadlineAt = now;
			await state.storage.put(GPU_LEASE_COORDINATOR_STORAGE_KEY, stored);
		});
		const identity = {
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
			now,
		};
		expect(await stub.renew(identity)).toEqual({ status: 'stale' });
		expect(await stub.beginCommitHold(identity)).toEqual({ status: 'stale' });
	});

	test.each(['full', 'already-queued', 'terminal'] as const)(
		'preserves capacity authority when persisted restoration is %s',
		async (condition) => {
			const stub = coordinator();
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
			const lease = await stub.acquire({ now });
			if (lease.status !== 'acquired') throw new Error('expected lease');
			await runInDurableObject(stub, async (_instance, state) => {
				const stored = await state.storage.get<PersistedGpuLeaseState>(
					GPU_LEASE_COORDINATOR_STORAGE_KEY,
				);
				if (!stored?.activeLease) throw new Error('expected persisted lease');
				stored.waiters = Array.from(
					{ length: condition === 'full' ? 10_000 : 1 },
					(_, index) => ({
						segmentId:
							condition === 'already-queued' ? 'one' : `other-${index}`,
						deadlineAt,
						kind: 'initial',
						ordinal: index + 2,
					}),
				);
				if (condition === 'terminal') stored.terminal.one = 'cancelled';
				await state.storage.put(GPU_LEASE_COORDINATOR_STORAGE_KEY, stored);
			});
			const identity = {
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
				now,
			};
			if (condition === 'full') {
				await runInDurableObject(stub, async (instance) => {
					await expect(instance.restoreCapacityBusy(identity)).rejects.toThrow(
						'GPU lease queue is full',
					);
				});
				expect(await stub.witness(identity)).toMatchObject({ status: 'ok' });
			} else {
				// Expiry must not duplicate queued or terminal work, either.
				expect(
					await stub.witness({ ...identity, now: lease.expiresAt }),
				).toEqual({ status: 'stale' });
				await runInDurableObject(stub, async (_instance, state) => {
					const stored = await state.storage.get<PersistedGpuLeaseState>(
						GPU_LEASE_COORDINATOR_STORAGE_KEY,
					);
					if (!stored) throw new Error('expected persisted state');
					stored.activeLease = {
						...lease,
						kind: 'initial',
						ordinal: 1,
						deadlineAt,
						holdExpiresAt: null,
						holdId: null,
					};
					await state.storage.put(GPU_LEASE_COORDINATOR_STORAGE_KEY, stored);
				});
				expect(await stub.restoreCapacityBusy(identity)).toEqual({
					status: 'ok',
				});
				expect(await stub.acquire({ now })).toMatchObject({
					status: 'acquired',
					segmentId: condition === 'already-queued' ? 'one' : 'other-0',
				});
			}
		},
	);

	test('releases only the exact expired waiter after failure without creating a completion receipt', async () => {
		const stub = coordinator();
		await stub.enqueue({
			segmentId: 'failed-output',
			deadlineAt,
			kind: 'initial',
		});
		await stub.enqueue({ segmentId: 'next', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		const identity = {
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
		};
		await stub.witness({ ...identity, now: lease.expiresAt });
		expect(await stub.release({ ...identity, completed: true })).toEqual({
			status: 'stale',
		});
		expect(
			await stub.release({ ...identity, leaseId: crypto.randomUUID() }),
		).toEqual({ status: 'stale' });
		expect(await stub.release({ ...identity, fence: lease.fence + 1 })).toEqual(
			{ status: 'stale' },
		);
		expect(await stub.release(identity)).toEqual({ status: 'ok' });
		await evictDurableObject(stub as unknown as DurableObjectStub);
		// A lost response can replay safely: the old waiter stays absent.
		expect(await coordinator().release(identity)).toEqual({ status: 'stale' });
		expect(
			await coordinator().release({ ...identity, completed: true }),
		).toEqual({ status: 'stale' });
		expect(await coordinator().acquire({ now: lease.expiresAt })).toMatchObject(
			{ status: 'acquired', segmentId: 'next' },
		);
	});

	test('cannot release a restored waiter belonging to a newer lease', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		const old = await stub.acquire({ now });
		if (old.status !== 'acquired') throw new Error('expected lease');
		const identity = {
			segmentId: old.segmentId,
			leaseId: old.leaseId,
			fence: old.fence,
		};
		await stub.witness({ ...identity, now: old.expiresAt });
		const newer = await stub.acquire({ now: old.expiresAt });
		if (newer.status !== 'acquired') throw new Error('expected replacement');
		expect(await stub.release(identity)).toEqual({ status: 'stale' });
		await stub.witness({
			segmentId: newer.segmentId,
			leaseId: newer.leaseId,
			fence: newer.fence,
			now: newer.expiresAt,
		});
		expect(await stub.release(identity)).toEqual({ status: 'stale' });
		expect(await stub.acquire({ now: newer.expiresAt })).toMatchObject({
			status: 'acquired',
			segmentId: 'one',
		});
	});

	test.each([false, true])(
		'replays completed release after eviction and a newer lease, including a lost response: %s',
		async (loseResponse) => {
			let stub = coordinator();
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
			const lease = await stub.acquire({ now });
			if (lease.status !== 'acquired') throw new Error('expected lease');
			const release = {
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
				completed: true,
			};
			const firstRelease = async () => {
				const result = await stub.release(release);
				if (loseResponse)
					throw new Error('response lost after persisted release');
				return result;
			};
			if (loseResponse)
				await expect(firstRelease()).rejects.toThrow('response lost');
			else expect(await firstRelease()).toEqual({ status: 'ok' });
			expect(await stub.release(release)).toEqual({ status: 'ok' });
			await evictDurableObject(stub as unknown as DurableObjectStub);
			stub = coordinator();
			expect(await stub.release(release)).toEqual({ status: 'ok' });
			await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
			const newer = await stub.acquire({ now });
			if (newer.status !== 'acquired') throw new Error('expected newer lease');
			expect(await stub.release(release)).toEqual({ status: 'ok' });
			expect(await stub.release({ ...release, completed: false })).toEqual({
				status: 'stale',
			});
			expect(
				await stub.release({ ...release, leaseId: crypto.randomUUID() }),
			).toEqual({ status: 'stale' });
			expect(
				await stub.release({ ...release, fence: release.fence + 1 }),
			).toEqual({ status: 'stale' });
			expect(await stub.release({ ...release, segmentId: 'unknown' })).toEqual({
				status: 'stale',
			});
			expect(
				await stub.witness({
					segmentId: newer.segmentId,
					leaseId: newer.leaseId,
					fence: newer.fence,
					now,
				}),
			).toEqual({ status: 'ok', expiresAt: newer.expiresAt });
		},
	);

	test.each(['expired', 'replaced', 'cancelled', 'ordinary'] as const)(
		'does not create a completion receipt for %s leases',
		async (reason) => {
			const stub = coordinator();
			await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
			const lease = await stub.acquire({ now });
			if (lease.status !== 'acquired') throw new Error('expected lease');
			const identity = {
				segmentId: lease.segmentId,
				leaseId: lease.leaseId,
				fence: lease.fence,
			};
			if (reason === 'expired' || reason === 'replaced') {
				expect(
					await stub.witness({ ...identity, now: lease.expiresAt }),
				).toEqual({ status: 'stale' });
				if (reason === 'replaced')
					expect(await stub.acquire({ now: lease.expiresAt })).toMatchObject({
						status: 'acquired',
					});
			} else if (reason === 'cancelled') {
				expect(await stub.cancel(identity)).toEqual({ status: 'cancelled' });
			} else {
				expect(await stub.release(identity)).toEqual({ status: 'ok' });
			}
			expect(await stub.release({ ...identity, completed: true })).toEqual({
				status: 'stale',
			});
			await evictDurableObject(stub as unknown as DurableObjectStub);
			expect(
				await coordinator().release({ ...identity, completed: true }),
			).toEqual({ status: 'stale' });
		},
	);

	test('normalizes old state without inferring completion from a terminal reason', async () => {
		const stub = coordinator();
		await runInDurableObject(stub, async (_instance, state) => {
			await state.storage.put(GPU_LEASE_COORDINATOR_STORAGE_KEY, {
				nextOrdinal: 0,
				fence: 7,
				waiters: [],
				activeLease: null,
				terminal: { one: 'completed' },
			});
		});
		expect(
			await stub.release({
				segmentId: 'one',
				leaseId: crypto.randomUUID(),
				fence: 7,
				completed: true,
			}),
		).toEqual({ status: 'stale' });
		await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		const release = {
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
			completed: true,
		};
		expect(await stub.release(release)).toEqual({ status: 'ok' });
		expect(await stub.release(release)).toEqual({ status: 'ok' });
	});

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

	test('lets a Workflow claim only its own FIFO-head segment', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'one', deadlineAt, kind: 'initial' });
		await stub.enqueue({ segmentId: 'two', deadlineAt, kind: 'initial' });
		expect(await stub.acquire({ segmentId: 'two', now })).toEqual({
			status: 'busy',
		});
		const first = await stub.acquire({ segmentId: 'one', now });
		expect(first.status).toBe('acquired');
		if (first.status === 'acquired') expect(first.segmentId).toBe('one');
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

	test('replays a busy restoration after eviction without moving its original FIFO waiter', async () => {
		const stub = coordinator();
		await stub.enqueue({ segmentId: 'first', deadlineAt, kind: 'initial' });
		const lease = await stub.acquire({ now });
		if (lease.status !== 'acquired') throw new Error('expected lease');
		await stub.enqueue({ segmentId: 'second', deadlineAt, kind: 'initial' });
		const command = {
			segmentId: lease.segmentId,
			leaseId: lease.leaseId,
			fence: lease.fence,
			now,
		};
		expect(await stub.requeueProviderLoss(command)).toEqual({ status: 'ok' });
		await evictDurableObject(stub as unknown as DurableObjectStub);
		expect(await coordinator().requeueProviderLoss(command)).toEqual({
			status: 'ok',
		});
		expect(await coordinator().acquire({ segmentId: 'second', now })).toEqual({
			status: 'busy',
		});
		expect(
			await coordinator().acquire({ segmentId: 'first', now }),
		).toMatchObject({ status: 'acquired', segmentId: 'first' });
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
			await stub.requeueProviderLoss({
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
					completedReleases: {},
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
					completedReleases: {},
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
					completedReleases: {},
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
