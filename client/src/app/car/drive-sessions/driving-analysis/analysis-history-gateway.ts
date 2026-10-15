import { httpResource } from '@angular/common/http';
import { Service, type Signal } from '@angular/core';
import { array, nullable, strictObject, string } from 'zod/mini';
import { drivingAnalysisSchema } from './driving-analysis.models';

const historyPage = strictObject({
	drivingAnalyses: array(drivingAnalysisSchema),
	nextCursor: nullable(string()),
});
export type HistorySelection = Readonly<{
	carId: string;
	driveSessionId: string;
	cursor: string | null;
}>;

@Service()
export class AnalysisHistoryGateway {
	read(selection: Signal<HistorySelection>) {
		return httpResource(
			() => {
				const { carId, driveSessionId, cursor } = selection();
				return carId && driveSessionId
					? {
							url: `/api/v1/cars/${encodeURIComponent(carId)}/drives/${encodeURIComponent(driveSessionId)}/driving-analyses`,
							withCredentials: true,
							params: cursor ? { cursor } : undefined,
						}
					: undefined;
			},
			{ parse: (value: unknown) => historyPage.parse(value) },
		);
	}
}
