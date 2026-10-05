import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service, type Signal } from '@angular/core';
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
	read(selection: Signal<{ analysisId: string; version: number }>) {
		return httpResource(
			() =>
				selection().analysisId
					? {
							url: url(selection().analysisId),
							withCredentials: true,
							params: { version: selection().version },
						}
					: undefined,
			{
				parse: (value) => reidentificationResponseSchema.parse(value).context,
			},
		);
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
