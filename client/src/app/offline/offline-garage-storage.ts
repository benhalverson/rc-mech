import { InjectionToken, inject, Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type { GarageCar } from '../garage/garage.models';

export const offlineDatabaseName = (): string => 'chassis-notes-offline-v1';

export const OFFLINE_DATABASE_NAME = new InjectionToken<string>(
	'OFFLINE_DATABASE_NAME',
	{ factory: offlineDatabaseName },
);

export type OfflineOwnerFenceStorage = Pick<
	Storage,
	'getItem' | 'removeItem' | 'setItem'
>;

export type OfflineOwnerFenceBrowser = Readonly<{
	localStorage?: OfflineOwnerFenceStorage;
}>;

export const offlineOwnerFenceStorage = (
	browser: OfflineOwnerFenceBrowser = globalThis,
): OfflineOwnerFenceStorage | null => {
	try {
		return browser.localStorage ?? null;
	} catch {
		return null;
	}
};

export const OFFLINE_OWNER_FENCE_STORAGE =
	new InjectionToken<OfflineOwnerFenceStorage | null>(
		'OFFLINE_OWNER_FENCE_STORAGE',
		{
			factory: offlineOwnerFenceStorage,
		},
	);

export const offlineOwnerFenceKey = (databaseName: string): string =>
	`${databaseName}:active-session`;

export const OFFLINE_SIGN_OUT_LEASE_MS = 30_000;
export const offlineCurrentTime = (): number => Date.now();
export const offlineCurrentTimeProvider = (): (() => number) =>
	offlineCurrentTime;
export const OFFLINE_CURRENT_TIME = new InjectionToken<() => number>(
	'OFFLINE_CURRENT_TIME',
	{ factory: offlineCurrentTimeProvider },
);
export const offlineOperationId = (): string => globalThis.crypto.randomUUID();
export const offlineOperationIdProvider = (): (() => string) =>
	offlineOperationId;
export const OFFLINE_OPERATION_ID = new InjectionToken<() => string>(
	'OFFLINE_OPERATION_ID',
	{ factory: offlineOperationIdProvider },
);

export type OfflineGarageSnapshot = Readonly<{
	ownerKey: string;
	ownerEmail: string;
	offlineUntil: string;
	preparedAt: string;
	cars: readonly GarageCar[];
}>;

type OfflineMetadata =
	| Readonly<{
			key: 'active-owner';
			ownerKey: string;
			sessionKey: string;
	  }>
	| Readonly<{
			key: 'sign-out';
			operationId: string;
			pendingUntil?: number;
			sessionKey: string;
			state: 'pending' | 'complete';
	  }>;

type RevokedOfflineSession = Readonly<{ sessionKey: string }>;

@Service()
export class OfflineGarageStorage {
	private readonly databaseName = inject(OFFLINE_DATABASE_NAME);
	private readonly ownerFenceStorage = inject(OFFLINE_OWNER_FENCE_STORAGE);
	private readonly now = inject(OFFLINE_CURRENT_TIME);
	private readonly nextOperationId = inject(OFFLINE_OPERATION_ID);
	private readonly ownerFenceKey = offlineOwnerFenceKey(this.databaseName);
	private readonly database = new Dexie(this.databaseName);
	private readonly snapshots: Table<OfflineGarageSnapshot, string>;
	private readonly metadata: Table<OfflineMetadata, string>;
	private readonly revokedSessions: Table<RevokedOfflineSession, string>;

	constructor() {
		this.database
			.version(1)
			.stores({ snapshots: '&ownerKey,preparedAt', metadata: '&key' });
		this.database
			.version(2)
			.stores({ revokedSessions: '&sessionKey' })
			.upgrade(async (transaction) => {
				// Version 1 did not retain a session id, so its snapshots cannot be
				// fenced safely after sign-out. Requiring a fresh online preparation
				// keeps the upgrade fail-closed.
				await transaction.table('snapshots').clear();
				await transaction.table('metadata').clear();
			});
		this.snapshots = this.database.table('snapshots');
		this.metadata = this.database.table('metadata');
		this.revokedSessions = this.database.table('revokedSessions');
	}

	async activate(ownerKey: string, sessionKey: string): Promise<boolean> {
		const ownerFenceStorage = this.ownerFenceStorage;
		if (!ownerFenceStorage) {
			await this.invalidateActiveOwner();
			throw new Error('Offline owner-fence storage is unavailable.');
		}
		let previousFence: string | null;
		const attemptedFence = JSON.stringify({ ownerKey, sessionKey });
		try {
			previousFence = ownerFenceStorage.getItem(this.ownerFenceKey);
			ownerFenceStorage.setItem(this.ownerFenceKey, attemptedFence);
		} catch (error) {
			await this.invalidateActiveOwner();
			throw error;
		}
		const activated = await this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.revokedSessions,
			async () => {
				const signOut = await this.metadata.get('sign-out');
				if (signOut?.key === 'sign-out') {
					if (
						(signOut.state === 'pending' &&
							(signOut.pendingUntil ?? 0) > this.now()) ||
						signOut.sessionKey === sessionKey
					)
						return false;
					await this.metadata.delete('sign-out');
				}
				if (await this.revokedSessions.get(sessionKey)) return false;
				const active = await this.metadata.get('active-owner');
				if (
					active?.key === 'active-owner' &&
					active.sessionKey !== sessionKey
				) {
					await this.snapshots.delete(active.ownerKey);
					await this.revokedSessions.put({ sessionKey: active.sessionKey });
				}
				await this.metadata.put({ key: 'active-owner', ownerKey, sessionKey });
				return true;
			},
		);
		if (!activated) {
			try {
				if (ownerFenceStorage.getItem(this.ownerFenceKey) === attemptedFence) {
					if (previousFence === null)
						ownerFenceStorage.removeItem(this.ownerFenceKey);
					else ownerFenceStorage.setItem(this.ownerFenceKey, previousFence);
				}
			} catch {
				// Leaving a mismatched fence in place fails closed for offline restore.
			}
		}
		return activated;
	}

	async deactivate(sessionKey?: string | null): Promise<string> {
		const operationId = this.nextOperationId();
		try {
			this.ownerFenceStorage?.removeItem(this.ownerFenceKey);
		} catch {
			// IndexedDB cleanup still invalidates restoration when the fence is blocked.
		}
		await this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.revokedSessions,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await this.snapshots.delete(active.ownerKey);
					await this.revokedSessions.put({ sessionKey: active.sessionKey });
				}
				await this.metadata.delete('active-owner');
				const signedOutSession =
					sessionKey ??
					(active?.key === 'active-owner' ? active.sessionKey : undefined);
				if (signedOutSession) {
					await this.revokedSessions.put({ sessionKey: signedOutSession });
					await this.metadata.put({
						key: 'sign-out',
						operationId,
						pendingUntil: this.now() + OFFLINE_SIGN_OUT_LEASE_MS,
						sessionKey: signedOutSession,
						state: 'pending',
					});
				}
			},
		);
		return operationId;
	}

	async completeSignOut(operationId: string): Promise<void> {
		await this.database.transaction(
			'rw',
			this.metadata,
			this.revokedSessions,
			async () => {
				const signOut = await this.metadata.get('sign-out');
				if (
					signOut?.key !== 'sign-out' ||
					signOut.state !== 'pending' ||
					signOut.operationId !== operationId
				)
					return;
				await this.metadata.put({
					key: 'sign-out',
					operationId,
					sessionKey: signOut.sessionKey,
					state: 'complete',
				});
				await this.revokedSessions.put({ sessionKey: signOut.sessionKey });
			},
		);
	}

	async save(
		snapshot: OfflineGarageSnapshot,
		sessionKey: string,
	): Promise<boolean> {
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (
					active?.key !== 'active-owner' ||
					active.ownerKey !== snapshot.ownerKey ||
					active.sessionKey !== sessionKey
				)
					return false;
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
		if (active?.key !== 'active-owner') return null;
		const ownerFenceStorage = this.ownerFenceStorage;
		if (!ownerFenceStorage) return null;
		try {
			const value: unknown = JSON.parse(
				ownerFenceStorage.getItem(this.ownerFenceKey) ?? 'null',
			);
			if (
				typeof value !== 'object' ||
				value === null ||
				!('ownerKey' in value) ||
				!('sessionKey' in value) ||
				value.ownerKey !== active.ownerKey ||
				value.sessionKey !== active.sessionKey
			)
				return null;
		} catch {
			return null;
		}
		const snapshot = await this.read(active.ownerKey);
		if (!snapshot || Date.parse(snapshot.offlineUntil) <= now.valueOf())
			return null;
		return snapshot;
	}

	close(): void {
		this.database.close();
	}

	private async invalidateActiveOwner(): Promise<void> {
		await this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.revokedSessions,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await this.snapshots.delete(active.ownerKey);
					await this.revokedSessions.put({ sessionKey: active.sessionKey });
				}
				await this.metadata.delete('active-owner');
			},
		);
	}
}
