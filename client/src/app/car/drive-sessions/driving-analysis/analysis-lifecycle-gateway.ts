import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service, type Signal } from '@angular/core';
import { map } from 'rxjs';
import { z } from 'zod';
import { drivingAnalysisResponseSchema } from './driving-analysis.models';

export const analysisLifecycleSchema = z.strictObject({
	analysisId: z.string(),
	status: z.enum([
		'queued',
		'running',
		'awaiting-reidentification',
		'completed',
		'failed',
		'cancelled',
		'deleting',
		'deleted',
	]),
	stateVersion: z.number().int().positive(),
	permanent: z.boolean(),
	canCancel: z.boolean(),
	canRetry: z.boolean(),
	failure: z
		.strictObject({ code: z.string(), retryable: z.boolean() })
		.nullable(),
});
export type AnalysisLifecycle = z.infer<typeof analysisLifecycleSchema>;
const responseSchema = z.strictObject({ lifecycle: analysisLifecycleSchema });
export type AnalysisLifecycleCommand = Readonly<
	{ analysisId: string; expectedStateVersion: number } & (
		| { action: 'cancel' | 'delete' }
		| { action: 'retry'; commandId: string }
	)
>;

@Service({ autoProvided: false })
export class AnalysisLifecycleGateway {
	private readonly http = inject(HttpClient);
	read(analysisId: Signal<string>) {
		return httpResource(
			() =>
				analysisId()
					? {
							url: `/api/v1/driving-analyses/${encodeURIComponent(analysisId())}/lifecycle`,
							withCredentials: true,
						}
					: undefined,
			{ parse: (value: unknown) => responseSchema.parse(value).lifecycle },
		);
	}
	mutate(command: AnalysisLifecycleCommand) {
		const url = `/api/v1/driving-analyses/${encodeURIComponent(command.analysisId)}`;
		const body = {
			expectedStateVersion: command.expectedStateVersion,
			...(command.action === 'retry' ? { commandId: command.commandId } : {}),
		};
		const request =
			command.action === 'delete'
				? this.http.delete<unknown>(url, { body, withCredentials: true })
				: this.http.post<unknown>(`${url}/${command.action}`, body, {
						withCredentials: true,
					});
		return request.pipe(
			map((value) => {
				if (command.action === 'delete') responseSchema.parse(value);
				else drivingAnalysisResponseSchema.parse(value);
			}),
		);
	}
}
