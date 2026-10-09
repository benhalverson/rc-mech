import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { forkJoin, map, type Observable } from 'rxjs';
import type { DriveSyncCollection } from '../car/drive-sync/drive-sync.models';
import { parseDriveSyncCollections } from '../car/drive-sync/drive-sync-gateway';
import { parseSetupSyncCollections } from '../car/setups/setup-snapshot';
import type { SetupSyncCollection } from '../car/setups/setup-sync.models';
import type { GarageCollection } from '../garage/garage.models';
import { parseGarageCollection } from '../garage/garage-gateway';
import type { MaintenanceSnapshot } from '../maintenance/maintenance-sync.models';
import { maintenanceSnapshotSchema } from '../maintenance/maintenance-sync-schema';

export type OfflineGarageCollection = GarageCollection &
	Readonly<{
		driveCollections: readonly DriveSyncCollection[];
		maintenance: MaintenanceSnapshot;
		setupCollections: readonly SetupSyncCollection[];
	}>;

@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<OfflineGarageCollection> {
		return forkJoin({
			maintenance: this.http.get<unknown>('/api/v1/maintenance/sync/snapshot', {
				withCredentials: true,
			}),
			drives: this.http.get<unknown>('/api/v1/drives', {
				withCredentials: true,
			}),
			garage: this.http.get<unknown>('/api/v1/cars', {
				withCredentials: true,
				params: { archived: 'all' },
			}),
			setups: this.http.get<unknown>('/api/v1/setups', {
				withCredentials: true,
			}),
		}).pipe(
			map(({ garage, setups, drives, maintenance }) => ({
				...parseGarageCollection(garage),
				maintenance: maintenanceSnapshotSchema.parse(maintenance),
				setupCollections: parseSetupSyncCollections(setups),
				driveCollections: parseDriveSyncCollections(drives),
			})),
		);
	}
}
