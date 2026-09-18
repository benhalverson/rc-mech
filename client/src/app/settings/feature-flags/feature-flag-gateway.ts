import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { map } from 'rxjs';
import { boolean, object } from 'zod/mini';

const flagSchema = object({ enabled: boolean() });
@Injectable()
export class FeatureFlagGateway {
	private readonly http = inject(HttpClient);
	save(command: Readonly<{ enabled: boolean }>) {
		return this.http
			.put<unknown>('/api/v1/feature-flags/driving-analysis', command, {
				withCredentials: true,
				timeout: 5000,
			})
			.pipe(map((value) => flagSchema.parse(value)));
	}
}
