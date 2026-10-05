import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import type * as z from 'zod/mini';
import { boolean, object } from 'zod/mini';

const flagSchema = object({ enabled: boolean() });
type DrivingAnalysisFlag = z.infer<typeof flagSchema>;

@Injectable()
export class FeatureFlagGateway {
	private readonly http = inject(HttpClient);
	save(command: Readonly<DrivingAnalysisFlag>) {
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
