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
import type { MaintenanceSnapshot } from '../maintenance/maintenance-sync.models';
import { maintenanceSnapshotSchema } from '../maintenance/maintenance-sync-schema';
import {
	type SettingsSnapshot,
	settingsSnapshotSchema,
} from '../settings/settings-sync.models';
import type { VoiceUpdate } from '../voice/voice.models';
import { parseVoiceUpdates } from '../voice/voice-gateway';

export type OfflineGarageCollection = GarageCollection &
	Readonly<{
		buildCollections: readonly BuildSyncCollection[];
		driveCollections: readonly DriveSyncCollection[];
		setupCollections: readonly SetupSyncCollection[];
		settings: SettingsSnapshot;
		voiceUpdates: readonly VoiceUpdate[];
		maintenance: MaintenanceSnapshot;
		photos: readonly CarPhoto[];
	}>;

@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<OfflineGarageCollection> {
		return forkJoin({
			voice: this.http.get<unknown>('/api/v1/voice-updates', {
				withCredentials: true,
			}),
			maintenance: this.http.get<unknown>('/api/v1/maintenance/sync/snapshot', {
				withCredentials: true,
			}),
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
			map(
				({
					garage,
					setups,
					builds,
					drives,
					timezone,
					invites,
					photos,
					maintenance,
					voice,
				}) => ({
					settings: settingsSnapshotSchema.parse({
						...Object(timezone),
						invites,
					}),
					photos: parsePhotoCollection(photos).photos,
					maintenance: maintenanceSnapshotSchema.parse(maintenance),
					voiceUpdates: parseVoiceUpdates(voice),
					...parseGarageCollection(garage),
					setupCollections: parseSetupSyncCollections(setups),
					buildCollections: parseBuildSyncCollections(builds),
					driveCollections: parseDriveSyncCollections(drives),
				}),
			),
		);
	}
}
