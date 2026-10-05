import { httpResource } from '@angular/common/http';
import { Service, type Signal } from '@angular/core';
import { cornerClipsSchema } from './corner-clip.models';
import { cornerReviewResponseSchema } from './corner-review.models';
import { parseDrivingAnalysis } from './driving-analysis-gateway';
import { parseRaceRecordingMutation } from './race-recording-gateway';

@Service()
export class CornerReviewGateway {
	readAnalysis(analysisId: Signal<string | null>) {
		return httpResource(
			() => {
				const id = analysisId();
				return id
					? {
							url: `/api/v1/driving-analyses/${encodeURIComponent(id)}`,
							withCredentials: true,
						}
					: undefined;
			},
			{ parse: parseDrivingAnalysis },
		);
	}

	readRecording(recordingId: Signal<string | null>) {
		return httpResource(
			() => {
				const id = recordingId();
				return id
					? {
							url: `/api/v1/race-videos/${encodeURIComponent(id)}`,
							withCredentials: true,
						}
					: undefined;
			},
			{ parse: parseRaceRecordingMutation },
		);
	}

	readClips(analysisId: Signal<string>) {
		return httpResource(
			() => {
				const id = analysisId();
				return id
					? {
							url: `/api/v1/driving-analyses/${encodeURIComponent(id)}/clips`,
							withCredentials: true,
						}
					: undefined;
			},
			{
				parse: (value: unknown) =>
					cornerClipsSchema.parse(value).clips.map((clip) => ({
						...clip,
						contentUrl:
							clip.status === 'ready'
								? `/api/v1/driving-analyses/${encodeURIComponent(analysisId())}/clips/${encodeURIComponent(clip.id)}/content`
								: null,
					})),
			},
		);
	}

	read(analysisId: Signal<string | null>) {
		return httpResource(
			() => {
				const id = analysisId();
				return id
					? {
							url: `/api/v1/driving-analyses/${encodeURIComponent(id)}/evidence`,
							withCredentials: true,
						}
					: undefined;
			},
			{
				parse: (value: unknown) =>
					cornerReviewResponseSchema.parse(value).evidence,
			},
		);
	}
}
