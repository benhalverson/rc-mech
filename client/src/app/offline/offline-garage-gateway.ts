import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { forkJoin, map, type Observable } from 'rxjs';
import { parseSetupSyncCollections } from '../car/setups/setup-snapshot';
import type { SetupSyncCollection } from '../car/setups/setup-sync.models';
import type { GarageCollection } from '../garage/garage.models';
import { parseGarageCollection } from '../garage/garage-gateway';

export type OfflineGarageCollection = GarageCollection &
	Readonly<{ setupCollections: readonly SetupSyncCollection[] }>;

@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<OfflineGarageCollection> {
		return forkJoin({
			garage: this.http.get<unknown>('/api/v1/cars', {
				withCredentials: true,
				params: { archived: 'all' },
			}),
			setups: this.http.get<unknown>('/api/v1/setups', {
				withCredentials: true,
			}),
		}).pipe(
			map(({ garage, setups }) => ({
				...parseGarageCollection(garage),
				setupCollections: parseSetupSyncCollections(setups),
			})),
		);
	}
}
