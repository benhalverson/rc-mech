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

type OfflineMetadata = Readonly<{
	key: 'active-owner';
	ownerKey: string;
}>;

@Service()
export class OfflineGarageStorage {
	private readonly database = new Dexie(inject(OFFLINE_DATABASE_NAME));
	private readonly snapshots: Table<OfflineGarageSnapshot, string>;
	private readonly metadata: Table<OfflineMetadata, string>;

	constructor() {
		this.database
			.version(1)
			.stores({ snapshots: '&ownerKey,preparedAt', metadata: '&key' });
		this.snapshots = this.database.table('snapshots');
		this.metadata = this.database.table('metadata');
	}

	async activate(ownerKey: string): Promise<void> {
		await this.metadata.put({ key: 'active-owner', ownerKey });
	}

	async deactivate(): Promise<void> {
		await this.metadata.delete('active-owner');
	}

	async save(snapshot: OfflineGarageSnapshot): Promise<boolean> {
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.ownerKey !== snapshot.ownerKey) return false;
				await this.snapshots.put(snapshot);
				return true;
			},
		);
	}

	async read(ownerKey: string): Promise<OfflineGarageSnapshot | null> {
		return (await this.snapshots.get(ownerKey)) ?? null;
	}

	async restoreCurrent(
		now = new Date(),
	): Promise<OfflineGarageSnapshot | null> {
		const active = await this.metadata.get('active-owner');
		if (!active) return null;
		const snapshot = await this.read(active.ownerKey);
		if (!snapshot || Date.parse(snapshot.offlineUntil) <= now.valueOf())
			return null;
		return snapshot;
	}

	close(): void {
		this.database.close();
	}
}
