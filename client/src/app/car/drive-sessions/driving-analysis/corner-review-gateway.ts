import { httpResource } from '@angular/common/http';
import { Service, type Signal } from '@angular/core';
import { cornerReviewResponseSchema } from './corner-review.models';

@Service()
export class CornerReviewGateway {
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
