import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { forkJoin, map, type Observable } from 'rxjs';
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
		setupCollections: readonly SetupSyncCollection[];
		settings: SettingsSnapshot;
	}>;

/**
 * Fetches the structured records and metadata needed by OfflineWorkspaceAccess
 * to prepare a Garage snapshot. Keeps authenticated HTTP and response validation
 * out of storage; a failed required read must not produce a partial ready snapshot.
 */
@Service()
export class OfflineGarageGateway {
	private readonly http = inject(HttpClient);

	load(): Observable<OfflineGarageCollection> {
		return forkJoin({
			timezone: this.http.get<unknown>('/api/v1/preferences/timezone', {
				withCredentials: true,
			}),
			invites: this.http.get<unknown>('/api/v1/invite-codes', {
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
			map(({ garage, setups, timezone, invites }) => ({
				settings: settingsSnapshotSchema.parse({
					...Object(timezone),
					invites,
				}),
				...parseGarageCollection(garage),
				setupCollections: parseSetupSyncCollections(setups),
			})),
		);
	}
}
