import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type { GarageCollection } from '../garage/garage.models';
import { parseGarageCollection } from '../garage/garage-gateway';

@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<GarageCollection> {
		return this.http
			.get<unknown>('/api/v1/cars', {
				withCredentials: true,
				params: { archived: 'all' },
			})
			.pipe(map(parseGarageCollection));
	}
}
