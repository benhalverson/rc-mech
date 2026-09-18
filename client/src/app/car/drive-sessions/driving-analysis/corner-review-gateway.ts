import { httpResource } from '@angular/common/http';
import { Service, type Signal } from '@angular/core';
import { cornerClipsSchema } from './corner-clip.models';
import { cornerReviewResponseSchema } from './corner-review.models';

@Service()
export class CornerReviewGateway {
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
