import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import type * as z from 'zod/mini';
import { boolean, object } from 'zod/mini';

import type { SaveDrivingAnalysisFlagCommand } from './driving-analysis-flag.models';

const flagSchema = object({ enabled: boolean() });
type DrivingAnalysisFlag = z.infer<typeof flagSchema>;

@Injectable()
export class DrivingAnalysisFlagGateway {
	private readonly http = inject(HttpClient);
	save(command: SaveDrivingAnalysisFlagCommand) {
		return this.http
			.put<DrivingAnalysisFlag>(
				'/api/v1/feature-flags/driving-analysis',
				command,
				{
					withCredentials: true,
					timeout: 5000,
				},
			)
			.pipe(map((value) => flagSchema.parse(value)));
	}
}
