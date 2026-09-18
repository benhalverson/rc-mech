import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import { map, type Observable } from 'rxjs';
import {
	type CorrectionReceipt,
	correctionReceiptSchema,
	type ReidentifySubjectCommand,
	reidentificationResponseSchema,
} from './reidentification.models';

const url = (analysisId: string) =>
	`/api/v1/driving-analyses/${encodeURIComponent(analysisId)}/reidentification`;

@Service()
export class ReidentificationGateway {
	private readonly http = inject(HttpClient);
	private readonly selected = signal('');
	readonly context = httpResource(
		() =>
			this.selected()
				? { url: url(this.selected()), withCredentials: true }
				: undefined,
		{
			parse: (value) => reidentificationResponseSchema.parse(value).context,
		},
	);
	select(analysisId: string): void {
		if (analysisId === this.selected()) {
			this.context.reload();
			return;
		}
		this.selected.set(analysisId);
	}
	correct(
		command: ReidentifySubjectCommand,
		correctionId: string,
	): Observable<CorrectionReceipt> {
		return this.http
			.post<unknown>(
				url(command.analysisId),
				{
					runId: command.context.runId,
					segmentId: command.context.segmentId,
					acceptedDigest: command.context.acceptedDigest,
					correctionId,
					subjectSeed: command.subjectSeed,
				},
				{ withCredentials: true },
			)
			.pipe(map((value) => correctionReceiptSchema.parse(value)));
	}
}
