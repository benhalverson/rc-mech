import type { WorkflowStep } from 'cloudflare:workers';
import type { DrivingAnalysisWorkflowPayload } from '../analysis/driving-analysis-contracts';
import type {
	GpuLeaseCancelInput,
	GpuLeaseCancelMutationResult,
} from '../gpu-lease-coordinator';
import type { TrackingProvider } from './local-sam31-provider';
import type { TrackingAuthority } from './tracking-authority';

export const TRACKING_CANCELLATION_GRACE_MS = 60_000;

/** D1 fencing precedes this runner. Release never asserts physical GPU shutdown. */
export class TrackingCancellation {
	constructor(
		private readonly authority: Pick<TrackingAuthority, 'cancellationTargets'>,
		private readonly provider: Pick<TrackingProvider, 'cancel'>,
		private readonly coordinator: {
			cancel(input: GpuLeaseCancelInput): Promise<GpuLeaseCancelMutationResult>;
		},
	) {}

	async run(
		payload: DrivingAnalysisWorkflowPayload,
		step: WorkflowStep,
	): Promise<{ kind: 'cancelled' }> {
		const targets = await step.do('load-fenced-cancellation-targets', () =>
			this.authority.cancellationTargets(
				payload.ownerId,
				payload.analysisId,
				payload.workflowId,
			),
		);
		for (const target of targets) {
			const identity = target.identity;
			if (identity) {
				const confirmed = await step.do(
					`cancel-provider-${identity.attemptId}`,
					async () => {
						try {
							const result = await this.provider.cancel({
								...identity,
								contractVersion: 'tracking-provider.v1',
							});
							return result.ok && result.value.state === 'cancelled';
						} catch {
							return false;
						}
					},
				);
				if (!confirmed) {
					const remaining = await step.do(
						`cancellation-grace-${identity.attemptId}`,
						async () =>
							Math.max(
								0,
								Date.parse(target.cancelledAt) +
									TRACKING_CANCELLATION_GRACE_MS -
									Date.now(),
							),
					);
					if (remaining > 0)
						await step.sleep(
							`wait-cancellation-${identity.attemptId}`,
							remaining,
						);
				}
			}
			await step.do(`release-cancelled-${target.segmentId}`, () =>
				this.coordinator.cancel(
					identity
						? {
								segmentId: identity.segmentId,
								leaseId: identity.leaseId,
								fence: identity.fencingToken,
							}
						: { segmentId: target.segmentId },
				),
			);
		}
		return { kind: 'cancelled' };
	}
}
