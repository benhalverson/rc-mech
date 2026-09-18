import type { WorkflowStep } from 'cloudflare:workers';
import { afterEach, expect, test, vi } from 'vitest';
import {
	cancelFixture,
	jobStatusFixture,
} from '../../testing/driving-analysis-tracking-fixtures';
import type { DrivingAnalysisWorkflowPayload } from '../analysis/driving-analysis-contracts';
import type { TrackingProvider } from './local-sam31-provider';
import { TrackingCancellation } from './tracking-cancellation';

const payload: DrivingAnalysisWorkflowPayload = {
	kind: 'analysis-creation.v1',
	cancellation: true,
	ownerId: 'owner-1',
	analysisId: 'analysis-1',
	workflowId: 'workflow-1',
	workflowSequence: 1,
	expectedStateVersion: 1,
};
const NOW = new Date('2026-09-18T12:00:00Z');
afterEach(() => vi.useRealTimers());

test.each([
	'confirmed',
	'unreachable',
	'requested',
	'throws',
	'partially-elapsed',
	'elapsed',
] as const)(
	'cancellation %s releases only after confirmation or persisted grace',
	async (mode) => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { contractVersion: _, ...identity } = cancelFixture();
		const trace: string[] = [];
		const authority = {
			cancellationTargets: vi.fn(async () => [
				{
					segmentId: identity.segmentId,
					identity,
					cancelledAt: new Date(
						NOW.getTime() -
							(mode === 'elapsed'
								? 60_000
								: mode === 'partially-elapsed'
									? 15_000
									: 0),
					).toISOString(),
				},
			]),
		};
		const provider = {
			cancel: vi.fn<TrackingProvider['cancel']>(async () => {
				trace.push('provider');
				if (mode === 'throws') throw new Error('secret provider detail');
				if (mode === 'confirmed' || mode === 'requested')
					return {
						ok: true,
						value: {
							...jobStatusFixture(),
							state: mode === 'confirmed' ? 'cancelled' : 'cancel-requested',
						},
					};
				return {
					ok: false,
					code: 'TRACKING_PROVIDER_UNAVAILABLE',
					retryable: true,
				};
			}),
		};
		const coordinator = {
			cancel: vi.fn(async () => {
				trace.push('release');
				return { status: 'cancelled' as const };
			}),
		};
		const cache = new Map<string, unknown>();
		const step = {
			do: async <T>(name: string, callback: () => Promise<T>) => {
				if (!cache.has(name)) cache.set(name, await callback());
				return cache.get(name) as T;
			},
			sleep: vi.fn(async (_name: string, duration: number) => {
				trace.push('grace');
				expect(duration).toBe(mode === 'partially-elapsed' ? 45_000 : 60_000);
				vi.advanceTimersByTime(duration);
			}),
		};
		const runner = new TrackingCancellation(authority, provider, coordinator);
		await expect(
			runner.run(payload, step as unknown as WorkflowStep),
		).resolves.toEqual({ kind: 'cancelled' });
		expect(trace).toEqual(
			mode === 'confirmed' || mode === 'elapsed'
				? ['provider', 'release']
				: ['provider', 'grace', 'release'],
		);
		expect(provider.cancel).toHaveBeenCalledWith(cancelFixture());
		expect(coordinator.cancel).toHaveBeenCalledWith({
			segmentId: identity.segmentId,
			leaseId: identity.leaseId,
			fence: identity.fencingToken,
		});
		await runner.run(payload, step as unknown as WorkflowStep);
		expect(provider.cancel).toHaveBeenCalledOnce();
		expect(coordinator.cancel).toHaveBeenCalledOnce();
	},
);

test('queued cancellation removes the waiter without contacting the provider', async () => {
	const authority = {
		cancellationTargets: vi.fn(async () => [
			{ segmentId: 'queued', identity: null, cancelledAt: NOW.toISOString() },
		]),
	};
	const provider = { cancel: vi.fn<TrackingProvider['cancel']>() };
	const coordinator = {
		cancel: vi.fn(async () => ({ status: 'cancelled' as const })),
	};
	const step = {
		do: async <T>(_name: string, callback: () => Promise<T>) => callback(),
	};
	await new TrackingCancellation(authority, provider, coordinator).run(
		payload,
		step as unknown as WorkflowStep,
	);
	expect(provider.cancel).not.toHaveBeenCalled();
	expect(coordinator.cancel).toHaveBeenCalledWith({ segmentId: 'queued' });
});

test('unreachable cancellation keeps capacity reserved for the full sixty-second grace', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(NOW);
	const { contractVersion: _, ...identity } = cancelFixture();
	const authority = {
		cancellationTargets: vi.fn(async () => [
			{
				segmentId: identity.segmentId,
				identity,
				cancelledAt: NOW.toISOString(),
			},
		]),
	};
	const provider = {
		cancel: vi.fn<TrackingProvider['cancel']>(async () => ({
			ok: false,
			code: 'TRACKING_PROVIDER_UNAVAILABLE',
			retryable: true,
		})),
	};
	const coordinator = {
		cancel: vi.fn(async () => ({ status: 'cancelled' as const })),
	};
	const step = {
		do: async <T>(_name: string, callback: () => Promise<T>) => callback(),
		sleep: vi.fn(
			async (_name: string, duration: number) =>
				new Promise<void>((resolve) => {
					setTimeout(resolve, duration);
				}),
		),
	};
	const completion = new TrackingCancellation(
		authority,
		provider,
		coordinator,
	).run(payload, step as unknown as WorkflowStep);
	await vi.advanceTimersByTimeAsync(0);
	expect(step.sleep).toHaveBeenCalledWith(
		`wait-cancellation-${identity.attemptId}`,
		60_000,
	);
	await vi.advanceTimersByTimeAsync(59_999);
	expect(coordinator.cancel).not.toHaveBeenCalled();
	expect(provider.cancel).toHaveBeenCalledOnce();
	expect(authority.cancellationTargets).toHaveBeenCalledOnce();
	await vi.advanceTimersByTimeAsync(1);
	await expect(completion).resolves.toEqual({ kind: 'cancelled' });
	expect(coordinator.cancel).toHaveBeenCalledOnce();
});
