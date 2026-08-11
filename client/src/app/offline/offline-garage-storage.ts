import { InjectionToken, inject, Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { GarageCar } from '../garage/garage.models';

export const offlineDatabaseName = (): string => 'chassis-notes-offline-v1';

export const OFFLINE_DATABASE_NAME = new InjectionToken<string>(
	'OFFLINE_DATABASE_NAME',
	{ factory: offlineDatabaseName },
);

export type OfflineGarageSnapshot = Readonly<{
	ownerKey: string;
	ownerEmail: string;
	offlineUntil: string;
	preparedAt: string;
	cars: readonly GarageCar[];
}>;

@Service()
export class OfflineGarageStorage {
	private readonly database = new Dexie(inject(OFFLINE_DATABASE_NAME));
	private readonly snapshots: Table<OfflineGarageSnapshot, string>;

	constructor() {
		this.database.version(1).stores({ snapshots: '&ownerKey,preparedAt' });
		this.snapshots = this.database.table('snapshots');
	}

	async save(snapshot: OfflineGarageSnapshot): Promise<void> {
		await this.snapshots.put(snapshot);
	}

	async read(ownerKey: string): Promise<OfflineGarageSnapshot | null> {
		return (await this.snapshots.get(ownerKey)) ?? null;
	}

	async restoreCurrent(
		now = new Date(),
	): Promise<OfflineGarageSnapshot | null> {
		const snapshot = await this.snapshots.orderBy('preparedAt').last();
		if (!snapshot || Date.parse(snapshot.offlineUntil) <= now.valueOf())
			return null;
		return snapshot;
	}

	close(): void {
		this.database.close();
	}
}
