import { InjectionToken, inject, Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import type {
	BuiltCarSyncOperation,
	CarSyncCommand,
	CarSyncOperation,
	CarSyncRemoteOutcome,
	CarSyncView,
} from '../garage/car-sync/car-sync.models';
import {
	buildCarSyncOperation,
	materializeCars,
	readyCarSyncOperations,
	rebaseCarSyncOperation,
} from '../garage/car-sync/car-sync-rules';
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

type ActiveOfflineOwner = Extract<OfflineMetadata, { key: 'active-owner' }>;

export type CommittedCarSyncOperation = BuiltCarSyncOperation &
	Readonly<{ view: CarSyncView }>;

export type OfflineWorkspaceFence = Readonly<{
	ownerKey: string;
	sessionKey: string;
}>;

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
	private readonly operations: Table<CarSyncOperation, string>;

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
		this.database.version(3).stores({
			operations: '&operationId,ownerKey,carId,status,createdAt',
		});
		this.snapshots = this.database.table('snapshots');
		this.metadata = this.database.table('metadata');
		this.revokedSessions = this.database.table('revokedSessions');
		this.operations = this.database.table('operations');
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
			this.operations,
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
				if (active?.key === 'active-owner' && active.ownerKey !== ownerKey) {
					await Promise.all([
						this.snapshots.delete(active.ownerKey),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
					]);
					await this.revokedSessions.put({ sessionKey: active.sessionKey });
				} else if (
					active?.key === 'active-owner' &&
					active.sessionKey !== sessionKey
				) {
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
			this.operations,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await Promise.all([
						this.snapshots.delete(active.ownerKey),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
					]);
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

	async carSyncView(): Promise<CarSyncView | null> {
		const current = await this.currentSnapshot();
		if (!current) return null;
		const operations = await this.ownerOperations(current.ownerKey);
		return this.view(current.cars, operations);
	}

	async commitCar(
		command: CarSyncCommand,
		fence: OfflineWorkspaceFence,
	): Promise<CommittedCarSyncOperation> {
		const operationId = this.nextOperationId();
		const carId =
			command.type === 'create' ? this.nextOperationId() : undefined;
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.operations,
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const operations = await this.ownerOperations(current.ownerKey);
				const cars = materializeCars(current.cars, operations);
				const built = buildCarSyncOperation(command, cars, operations, {
					ownerKey: current.ownerKey,
					operationId,
					carId,
					createdAt: new Date(this.now()).toISOString(),
				});
				await this.operations.add(built.operation);
				const nextOperations = [...operations, built.operation];
				return {
					...built,
					view: this.view(current.cars, nextOperations),
				};
			},
		);
	}

	async readyCarOperations(): Promise<readonly CarSyncOperation[]> {
		const view = await this.carSyncView();
		return view ? readyCarSyncOperations(view.operations) : [];
	}

	async recordCarOutcome(outcome: CarSyncRemoteOutcome): Promise<CarSyncView> {
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.operations,
			async () => {
				const current = await this.currentSnapshot();
				if (!current) throw new Error('The offline Garage is unavailable.');
				let canonicalCars = current.cars;
				const operation = await this.operations.get(outcome.operationId);
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						canonicalCars = this.mergeCanonicalCars(current.cars, [
							outcome.car,
						]);
						// mergeCanonicalCars always inserts or retains the candidate identity.
						const acknowledgedCar = canonicalCars.find(
							(car) => car.id === outcome.car.id,
						) as GarageCar;
						await Promise.all([
							this.snapshots.put({ ...current, cars: canonicalCars }),
							this.operations.delete(operation.operationId),
						]);
						const dependents = await this.ownerOperations(current.ownerKey);
						await this.operations.bulkPut(
							dependents.map((candidate) =>
								rebaseCarSyncOperation(
									candidate,
									operation.operationId,
									acknowledgedCar,
								),
							),
						);
					} else if (outcome.outcome === 'rejected') {
						await this.operations.put({
							...operation,
							status: 'needs-attention',
							feedback: outcome.error,
						});
					} else {
						await this.operations.put({
							...operation,
							status: 'conflict',
							feedback: outcome.error,
							remote: outcome.remote.car,
						});
					}
				}
				return this.view(
					canonicalCars,
					await this.ownerOperations(current.ownerKey),
				);
			},
		);
	}

	async replaceCars(cars: readonly GarageCar[]): Promise<CarSyncView> {
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.operations,
			async () => {
				const current = await this.currentSnapshot();
				if (!current) throw new Error('The offline Garage is unavailable.');
				await this.snapshots.put({ ...current, cars });
				return this.view(cars, await this.ownerOperations(current.ownerKey));
			},
		);
	}

	async mergeCars(
		cars: readonly GarageCar[],
		fence: OfflineWorkspaceFence,
	): Promise<CarSyncView> {
		return this.database.transaction(
			'rw',
			this.snapshots,
			this.metadata,
			this.operations,
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const canonicalCars = this.mergeCanonicalCars(current.cars, cars);
				await this.snapshots.put({ ...current, cars: canonicalCars });
				return this.view(
					canonicalCars,
					await this.ownerOperations(current.ownerKey),
				);
			},
		);
	}

	async restoreCurrent(
		now = new Date(),
	): Promise<OfflineGarageSnapshot | null> {
		const snapshot = await this.currentSnapshot(now);
		if (!snapshot) return null;
		const operations = await this.ownerOperations(snapshot.ownerKey);
		return { ...snapshot, cars: materializeCars(snapshot.cars, operations) };
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
			this.operations,
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await Promise.all([
						this.snapshots.delete(active.ownerKey),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
					]);
					await this.revokedSessions.put({ sessionKey: active.sessionKey });
				}
				await this.metadata.delete('active-owner');
			},
		);
	}

	private async currentSnapshot(
		now = new Date(this.now()),
		fence?: OfflineWorkspaceFence,
	): Promise<OfflineGarageSnapshot | null> {
		const active = await this.metadata.get('active-owner');
		if (
			active?.key !== 'active-owner' ||
			(fence !== undefined &&
				(active.ownerKey !== fence.ownerKey ||
					active.sessionKey !== fence.sessionKey)) ||
			!this.matchesOwnerFence(active)
		)
			return null;
		const snapshot = await this.snapshots.get(active.ownerKey);
		if (!snapshot || Date.parse(snapshot.offlineUntil) <= now.valueOf())
			return null;
		return snapshot;
	}

	private matchesOwnerFence(active: ActiveOfflineOwner): boolean {
		const ownerFenceStorage = this.ownerFenceStorage;
		if (!ownerFenceStorage) return false;
		try {
			const value: unknown = JSON.parse(
				ownerFenceStorage.getItem(this.ownerFenceKey) ?? 'null',
			);
			return (
				typeof value === 'object' &&
				value !== null &&
				'ownerKey' in value &&
				'sessionKey' in value &&
				value.ownerKey === active.ownerKey &&
				value.sessionKey === active.sessionKey
			);
		} catch {
			return false;
		}
	}

	private ownerOperations(ownerKey: string): Promise<CarSyncOperation[]> {
		return this.operations
			.where('ownerKey')
			.equals(ownerKey)
			.sortBy('createdAt');
	}

	private view(
		canonicalCars: readonly GarageCar[],
		operations: readonly CarSyncOperation[],
	): CarSyncView {
		return {
			canonicalCars,
			cars: materializeCars(canonicalCars, operations),
			operations,
		};
	}

	private mergeCanonicalCars(
		current: readonly GarageCar[],
		incoming: readonly GarageCar[],
	): readonly GarageCar[] {
		const merged = new Map(current.map((car) => [car.id, car]));
		for (const candidate of incoming) {
			const existing = merged.get(candidate.id);
			if (
				!existing ||
				existing.version === undefined ||
				(candidate.version !== undefined &&
					candidate.version >= existing.version)
			)
				merged.set(candidate.id, candidate);
		}
		return [...merged.values()];
	}
}
