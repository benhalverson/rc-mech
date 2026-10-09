import { HttpClient, httpResource } from '@angular/common/http';
import { inject, Service, type Signal } from '@angular/core';
import { map, type Observable } from 'rxjs';
import { subjectFrameContentUrl } from './driving-analysis-gateway';
import {
	type CorrectionFrame,
	type CorrectionReceipt,
	type CorrectionRecordingIdentity,
	correctionReceiptSchema,
	type ReidentificationContext,
	type ReidentifySubjectCommand,
	reidentificationResponseSchema,
} from './reidentification.models';

const url = (analysisId: string) =>
	`/api/v1/driving-analyses/${encodeURIComponent(analysisId)}/reidentification`;

@Service()
export class ReidentificationGateway {
	private readonly http = inject(HttpClient);
	/** Enriches prepared frames without changing accepted context or source identity. */
	frames(
		context: ReidentificationContext | null,
		identity: CorrectionRecordingIdentity | null,
	): readonly CorrectionFrame[] {
		return (context?.frames ?? []).map((frame) => ({
			...frame,
			contentUrl: identity
				? subjectFrameContentUrl(
						identity.recordingId,
						frame.frameIndex,
						identity.checksumSha256,
					)
				: null,
		}));
	}
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
