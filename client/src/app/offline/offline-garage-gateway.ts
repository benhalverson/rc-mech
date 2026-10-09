import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { forkJoin, map, type Observable } from 'rxjs';
import type { BuildSyncCollection } from '../car/build-sync/build-sync.models';
import { parseBuildSyncCollections } from '../car/build-sync/build-sync-gateway';
import type { CarPhoto } from '../car/car.models';
import type { DriveSyncCollection } from '../car/drive-sync/drive-sync.models';
import { parseDriveSyncCollections } from '../car/drive-sync/drive-sync-gateway';
import { parsePhotoCollection } from '../car/photos/car-photo-gateway';
import { parseSetupSyncCollections } from '../car/setups/setup-snapshot';
import type { SetupSyncCollection } from '../car/setups/setup-sync.models';
import type { GarageCollection } from '../garage/garage.models';
import { parseGarageCollection } from '../garage/garage-gateway';
import {
	type SettingsSnapshot,
	settingsSnapshotSchema,
} from '../settings/settings-sync.models';

export type OfflineGarageCollection = GarageCollection &
	Readonly<{
		buildCollections: readonly BuildSyncCollection[];
		driveCollections: readonly DriveSyncCollection[];
		setupCollections: readonly SetupSyncCollection[];
		settings: SettingsSnapshot;
		photos: readonly CarPhoto[];
	}>;

@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<OfflineGarageCollection> {
		return forkJoin({
			photos: this.http.get<unknown>('/api/v1/photos', {
				withCredentials: true,
			}),
			timezone: this.http.get<unknown>('/api/v1/preferences/timezone', {
				withCredentials: true,
			}),
			invites: this.http.get<unknown>('/api/v1/invite-codes', {
				withCredentials: true,
			}),
			drives: this.http.get<unknown>('/api/v1/drives', {
				withCredentials: true,
			}),
			builds: this.http.get<unknown>('/api/v1/components', {
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
			map(({ garage, setups, builds, drives, timezone, invites, photos }) => ({
				settings: settingsSnapshotSchema.parse({
					...Object(timezone),
					invites,
				}),
				photos: parsePhotoCollection(photos),
				...parseGarageCollection(garage),
				setupCollections: parseSetupSyncCollections(setups),
				buildCollections: parseBuildSyncCollections(builds),
				driveCollections: parseDriveSyncCollections(drives),
			})),
		);
	}
}
