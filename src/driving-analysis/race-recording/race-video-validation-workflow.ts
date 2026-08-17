import {
	WorkflowEntrypoint,
	type WorkflowEvent,
	type WorkflowStep,
} from 'cloudflare:workers';
import type { RaceVideoMediaValidationCommand } from './race-video-media-container';
import { RaceVideoValidationAuthority } from './race-video-validation-authority';
import type { RaceVideoValidationResponse } from './race-video-validation-contracts';
import {
	RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	type RaceVideoValidationWorkflowPayload,
	raceVideoValidationWorkflowPayloadSchema,
} from './race-video-validation-contracts';

const VALIDATION_STEP = {
	retries: { limit: 2, delay: '5 seconds', backoff: 'constant' },
	timeout: '20 minutes',
} as const;

type RaceVideoMediaContainerPort = {
	validateRaceVideo(
		command: RaceVideoMediaValidationCommand,
	): Promise<RaceVideoValidationResponse>;
};

export type RaceVideoValidationWorkflowEnvironment = {
	DB: D1Database;
	RACE_VIDEO_MEDIA_CONTAINER: {
		getByName(name: string): RaceVideoMediaContainerPort;
	};
};

export type RaceVideoValidationWorkflowResult = Readonly<{
	status: 'published' | 'replayed' | 'stale';
}>;

const unavailableResponse = (
	validationId: string,
): RaceVideoValidationResponse => ({
	contractVersion: RACE_VIDEO_VALIDATION_CONTRACT_VERSION,
	correlationId: validationId,
	outcome: 'rejected',
	error: {
		code: 'SERVICE_UNAVAILABLE',
		stage: 'admission',
		message: 'The media validation service is temporarily unavailable.',
	},
});

export class RaceVideoValidationWorkflowRunner {
	constructor(
		private readonly authority: RaceVideoValidationAuthority,
		private readonly containers: RaceVideoValidationWorkflowEnvironment['RACE_VIDEO_MEDIA_CONTAINER'],
		private readonly clock: () => Date = () => new Date(),
	) {}

	async run(
		event: Readonly<WorkflowEvent<RaceVideoValidationWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<RaceVideoValidationWorkflowResult> {
		const payload = raceVideoValidationWorkflowPayloadSchema.parse(
			event.payload,
		);
		const context = await step.do('load-race-video-validation', async () =>
			this.authority.context(payload),
		);
		if (context.kind === 'stale') return { status: 'stale' };
		if (context.kind === 'terminal') return { status: 'replayed' };

		let response: RaceVideoValidationResponse;
		try {
			response = await step.do(
				'validate-private-race-video',
				VALIDATION_STEP,
				async () =>
					this.containers.getByName(context.validationId).validateRaceVideo({
						recordingId: context.recordingId,
						validationId: context.validationId,
						objectKey: context.objectKey,
						expectedByteCount: context.expectedByteCount,
					}),
			);
		} catch {
			response = unavailableResponse(context.validationId);
		}

		const status = await step.do('publish-race-video-validation', async () =>
			this.authority.publish(payload, response, this.clock().toISOString()),
		);
		return { status };
	}
}

export class RaceVideoValidationWorkflow extends WorkflowEntrypoint<
	RaceVideoValidationWorkflowEnvironment,
	RaceVideoValidationWorkflowPayload
> {
	run(
		event: Readonly<WorkflowEvent<RaceVideoValidationWorkflowPayload>>,
		step: WorkflowStep,
	): Promise<RaceVideoValidationWorkflowResult> {
		return new RaceVideoValidationWorkflowRunner(
			new RaceVideoValidationAuthority(this.env.DB),
			this.env.RACE_VIDEO_MEDIA_CONTAINER,
		).run(event, step);
	}
}
