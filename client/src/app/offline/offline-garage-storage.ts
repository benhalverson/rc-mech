import { InjectionToken, inject, Service } from '@angular/core';
import Dexie, { type Table } from 'dexie';
import {
	applyPhotoChange,
	type PhotoChange,
	photoChangeBase,
	photoChangesOverlap,
	photoChangeTouchesGallery,
} from '../../../../shared/photo-sync';
import type {
	BuildSyncCollection,
	BuildSyncCommand,
	BuildSyncOperation,
	BuildSyncRemoteOutcome,
	BuildSyncView,
} from '../car/build-sync/build-sync.models';
import {
	buildBuildSyncOperation,
	materializeBuildCollections,
	mergeBuildCollection,
	readyBuildSyncOperations,
	rebaseBuildSyncOperation,
} from '../car/build-sync/build-sync-rules';
import type { CarPhoto, PhotoMutationCommand } from '../car/car.models';
import type {
	DriveSyncCollection,
	DriveSyncCommand,
	DriveSyncOperation,
	DriveSyncRemoteOutcome,
	DriveSyncView,
} from '../car/drive-sync/drive-sync.models';
import {
	buildDriveSyncOperation,
	materializeDriveCollections,
	mergeDriveCollection,
	readyDriveSyncOperations,
	rebaseDriveSyncOperation,
} from '../car/drive-sync/drive-sync-rules';
import type {
	PhotoChangeOperation,
	PhotoChangeOutcome,
} from '../car/photos/photo-sync.models';
import {
	materializePhotos,
	type PhotoCapture,
	type PhotoCaptureOutcome,
	type PhotoMedia,
	type PhotoView,
} from '../car/photos/photo-sync.models';
import type {
	BuiltSetupSyncOperation,
	SetupSyncCollection,
	SetupSyncCommand,
	SetupSyncOperation,
	SetupSyncRemoteOutcome,
	SetupSyncView,
} from '../car/setups/setup-sync.models';
import {
	buildSetupSyncOperation,
	materializeSetupCollections,
	readySetupSyncOperations,
	rebaseSetupSyncOperation,
} from '../car/setups/setup-sync-rules';
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
import type {
	MaintenanceCommand,
	MaintenanceOperation,
	MaintenanceRemoteOutcome,
	MaintenanceSnapshot,
	MaintenanceView,
} from '../maintenance/maintenance-sync.models';
import {
	buildMaintenanceOperation,
	maintenanceView,
	rebaseMaintenanceOperation,
} from '../maintenance/maintenance-sync-rules';
import type {
	SettingsCommand,
	SettingsOperation,
	SettingsRemoteOutcome,
	SettingsSnapshot,
	SettingsView,
} from '../settings/settings-sync.models';
import {
	acknowledgeSettings,
	settingsDependencies,
	settingsView,
} from '../settings/settings-sync-rules';
import type { PendingVoiceCapture, VoiceUpdate } from '../voice/voice.models';
import type {
	VoiceCapture,
	VoiceWorkingCopy,
} from '../voice/voice-sync.models';
import { OFFLINE_CONTRACT_VERSION } from './offline-contract';
import type {
	ReviewDecision,
	ReviewFamily,
	ReviewOperation,
	SyncReview,
} from './offline-sync-review.models';
import { retryReviewedOperation } from './offline-sync-review-rules';

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
	contractVersion?: number;
	ownerKey: string;
	ownerEmail: string;
	sessionKey?: string;
	settings?: SettingsSnapshot;
	voiceUpdates?: readonly VoiceUpdate[];
	maintenance?: MaintenanceSnapshot;
	photos?: readonly CarPhoto[];
	offlineUntil: string;
	preparedAt: string;
	cars: readonly GarageCar[];
	setupCollections?: readonly SetupSyncCollection[];
	buildCollections?: readonly BuildSyncCollection[];
	driveCollections?: readonly DriveSyncCollection[];
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

export type CommittedSetupSyncOperation = BuiltSetupSyncOperation &
	Readonly<{ view: SetupSyncView }>;

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
	private readonly setupOperations: Table<SetupSyncOperation, string>;
	private readonly buildOperations: Table<BuildSyncOperation, string>;
	private readonly driveOperations: Table<DriveSyncOperation, string>;
	private readonly settingsOperations: Table<SettingsOperation, string>;
	private readonly voiceCaptures: Table<VoiceCapture, string>;
	private readonly maintenanceOperations: Table<MaintenanceOperation, string>;
	private readonly photoChanges: Table<PhotoChangeOperation, string>;
	private readonly photoCaptures: Table<PhotoCapture, string>;
	private readonly photoMedia: Table<PhotoMedia, [string, string]>;

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
		this.database.version(4).stores({
			setupOperations: '&operationId,ownerKey,carId,setupId,status,createdAt',
		});
		this.database.version(5).stores({
			buildOperations: '&operationId,ownerKey,carId,status,createdAt',
		});
		this.database.version(6).stores({
			driveOperations: '&operationId,ownerKey,carId,status,createdAt',
		});
		this.database
			.version(7)
			.stores({ settingsOperations: '&operationId,ownerKey,status,createdAt' });
		this.database.version(8).stores({
			photoCaptures: '&operationId,ownerKey,carId,status',
			photoMedia: '[ownerKey+photoId],ownerKey',
		});

		this.database.version(9).stores({
			maintenanceOperations: '&operationId,ownerKey,carId,status,createdAt',
		});

		this.database
			.version(10)
			.stores({ voiceCaptures: '&id,ownerKey,carId,status,phase,createdAt' });

		this.database
			.version(11)
			.stores({ photoChanges: '&operationId,ownerKey,carId,status,createdAt' })
			.upgrade(async (transaction) => {
				await transaction
					.table('snapshots')
					.toCollection()
					.modify((snapshot: { contractVersion?: number }) => {
						if (snapshot.contractVersion === 1)
							snapshot.contractVersion = OFFLINE_CONTRACT_VERSION;
					});
			});
		this.photoChanges = this.database.table('photoChanges');
		this.maintenanceOperations = this.database.table('maintenanceOperations');
		this.voiceCaptures = this.database.table('voiceCaptures');
		this.photoCaptures = this.database.table('photoCaptures');
		this.photoMedia = this.database.table('photoMedia');
		this.settingsOperations = this.database.table('settingsOperations');
		this.driveOperations = this.database.table('driveOperations');
		this.buildOperations = this.database.table('buildOperations');
		this.snapshots = this.database.table('snapshots');
		this.metadata = this.database.table('metadata');
		this.revokedSessions = this.database.table('revokedSessions');
		this.operations = this.database.table('operations');
		this.setupOperations = this.database.table('setupOperations');
	}

	async voiceView(fence: OfflineWorkspaceFence): Promise<VoiceWorkingCopy> {
		const snapshot = await this.currentSnapshot(undefined, fence);
		if (!snapshot) throw new Error('The offline Garage is unavailable.');
		const captures = await this.voiceCaptures
			.where('ownerKey')
			.equals(snapshot.ownerKey)
			.sortBy('createdAt');
		const updates = new Map(
			(snapshot.voiceUpdates ?? []).map((update) => [update.id, update]),
		);
		for (const capture of captures)
			if (
				capture.remote &&
				(!updates.has(capture.id) ||
					(updates.get(capture.id) as VoiceUpdate).updatedAt <=
						capture.remote.updatedAt)
			)
				updates.set(capture.id, capture.remote);
		return { captures, updates: [...updates.values()] };
	}
	async retainedVoiceOriginal(
		id: string,
		fence: OfflineWorkspaceFence,
	): Promise<Blob | null> {
		const view = await this.voiceView(fence);
		const update = view.updates.find((value) => value.id === id);
		if (!update || update.artifactDeletedAt) return null;
		return view.captures.find((capture) => capture.id === id)?.blob ?? null;
	}
	async retainVoiceOriginal(
		id: string,
		blob: Blob,
		fence: OfflineWorkspaceFence,
	): Promise<void> {
		await this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.voiceCaptures],
			async () => {
				const view = await this.voiceView(fence);
				const update = view.updates.find((value) => value.id === id);
				if (!update?.audioUrl || update.artifactDeletedAt)
					throw new Error('Original voice recording is unavailable.');
				const capture = view.captures.find((value) => value.id === id);
				await this.voiceCaptures.put(
					capture
						? { ...capture, blob }
						: {
								id,
								ownerKey: fence.ownerKey,
								carId: update.carId,
								driveSessionId: update.driveSessionId,
								blob,
								contentType: blob.type,
								fileName: update.fileName ?? 'voice-recording',
								createdAt: update.createdAt,
								status: 'queued',
								error: null,
								phase: 'retained',
								dependencies: [],
								remote: update,
							},
				);
			},
		);
	}

	async keepVoice(
		capture: PendingVoiceCapture,
		fence: OfflineWorkspaceFence,
	): Promise<VoiceWorkingCopy> {
		await this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.driveOperations,
				this.voiceCaptures,
			],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const carView = this.view(
					snapshot.cars,
					await this.ownerOperations(snapshot.ownerKey),
				);
				if (
					!carView.cars.some(
						(car) => car.id === capture.carId && !car.archivedAt,
					)
				)
					throw new Error('An active Car is required.');
				const drives = this.driveView(
					snapshot.driveCollections ?? [],
					await this.ownerDriveOperations(snapshot.ownerKey),
				);
				if (
					capture.driveSessionId &&
					!drives.collections.some(
						(collection) =>
							collection.carId === capture.carId &&
							collection.sessions.some(
								(session) =>
									session.id === capture.driveSessionId && !session.deletedAt,
							),
					)
				)
					throw new Error('A matching Drive session is required.');
				const existing = await this.voiceCaptures.get(capture.id);
				if (existing) {
					if (existing.ownerKey !== snapshot.ownerKey)
						throw new Error('Capture identity is unavailable.');
					return;
				}
				const dependencies = [...carView.operations, ...drives.operations]
					.filter((operation) => operation.carId === capture.carId)
					.map((operation) => operation.operationId);
				await this.voiceCaptures.add({
					...capture,
					ownerKey: snapshot.ownerKey,
					phase: 'upload',
					dependencies,
					status: 'queued',
					error: null,
				});
			},
		);
		return this.voiceView(fence);
	}
	async importVoice(
		captures: readonly PendingVoiceCapture[],
		fence: OfflineWorkspaceFence,
	): Promise<void> {
		await this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.voiceCaptures],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				for (const capture of captures) {
					if (capture.ownerKey !== snapshot.ownerEmail.trim().toLowerCase())
						throw new Error('Voice capture belongs to another User.');
					const existing = await this.voiceCaptures.get(capture.id);
					if (existing && existing.ownerKey !== snapshot.ownerKey)
						throw new Error('Capture identity is unavailable.');
					if (!existing)
						await this.voiceCaptures.add({
							...capture,
							ownerKey: snapshot.ownerKey,
							phase: 'upload',
							dependencies: [],
							status: capture.status === 'failed' ? 'failed' : 'queued',
						});
				}
			},
		);
	}
	async readyVoice(
		fence: OfflineWorkspaceFence,
	): Promise<readonly VoiceCapture[]> {
		return this.database.transaction(
			'r',
			[
				this.snapshots,
				this.metadata,
				this.voiceCaptures,
				this.operations,
				this.driveOperations,
			],
			async () => {
				const view = await this.voiceView(fence);
				const cars = await this.operations
					.where('ownerKey')
					.equals(fence.ownerKey)
					.toArray();
				const drives = await this.driveOperations
					.where('ownerKey')
					.equals(fence.ownerKey)
					.toArray();
				const pending = new Set(
					[...cars, ...drives].map((operation) => operation.operationId),
				);
				return view.captures.filter(
					(capture) =>
						capture.phase !== 'retained' &&
						capture.status !== 'failed' &&
						!capture.dependencies.some((id) => pending.has(id)),
				);
			},
		);
	}
	async changeVoice(
		id: string,
		change:
			| Readonly<{
					phase?: VoiceCapture['phase'];
					status?: VoiceCapture['status'];
					error?: string | null;
					remote?: VoiceUpdate;
			  }>
			| 'discard',
		fence: OfflineWorkspaceFence,
	): Promise<VoiceWorkingCopy> {
		await this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.voiceCaptures],
			async () => {
				if (!(await this.currentSnapshot(undefined, fence)))
					throw new Error('The offline Garage is unavailable.');
				const existing = await this.voiceCaptures.get(id);
				if (existing?.ownerKey !== fence.ownerKey) return;
				if (change === 'discard') await this.voiceCaptures.delete(id);
				else await this.voiceCaptures.put({ ...existing, ...change });
			},
		);
		return this.voiceView(fence);
	}
	async refreshVoice(
		updates: readonly VoiceUpdate[],
		fence: OfflineWorkspaceFence,
	): Promise<VoiceWorkingCopy> {
		await this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.voiceCaptures],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const canonical = new Map(
					(snapshot.voiceUpdates ?? []).map((update) => [update.id, update]),
				);
				for (const update of updates) {
					const previous = canonical.get(update.id);
					if (previous && previous.updatedAt > update.updatedAt) continue;
					canonical.set(update.id, update);
					if (update.artifactDeletedAt) {
						const capture = await this.voiceCaptures.get(update.id);
						if (capture?.ownerKey === fence.ownerKey && capture.remote)
							await this.voiceCaptures.put({
								...capture,
								blob: undefined,
								phase: 'retained',
								remote: update,
								error: null,
							});
					}
				}
				await this.snapshots.put({
					...snapshot,
					voiceUpdates: [...canonical.values()],
				});
			},
		);
		return this.voiceView(fence);
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
			[
				this.snapshots,
				this.metadata,
				this.revokedSessions,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
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
						this.buildOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.driveOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoMedia.where('ownerKey').equals(active.ownerKey).delete(),
						this.photoChanges
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.settingsOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.voiceCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.maintenanceOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
						this.setupOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
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

	async isSessionRevoked(sessionKey: string): Promise<boolean> {
		return Boolean(await this.revokedSessions.get(sessionKey));
	}
	async pendingWorkCount(
		legacyVoiceIds: readonly string[] = [],
	): Promise<number> {
		const active = await this.metadata.get('active-owner');
		return active?.key === 'active-owner'
			? this.ownerPendingWorkCount(active.ownerKey, legacyVoiceIds)
			: 0;
	}
	private async ownerPendingWorkCount(
		ownerKey: string,
		legacyVoiceIds: readonly string[] = [],
	): Promise<number> {
		const counts = await Promise.all(
			[
				this.operations,
				this.setupOperations,
				this.settingsOperations,

				this.maintenanceOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
			].map((table) => table.where('ownerKey').equals(ownerKey).count()),
		);
		return (
			counts.reduce((total, value) => total + value, 0) +
			(await this.voiceCaptures
				.where('ownerKey')
				.equals(ownerKey)
				.filter(
					(capture) =>
						capture.phase !== 'retained' &&
						!legacyVoiceIds.includes(capture.id),
				)
				.count())
		);
	}
	async requestSignOut(
		sessionKey: string | null,
		discardPending: boolean,
	): Promise<
		| Readonly<{ kind: 'confirmation'; count: number }>
		| Readonly<{ kind: 'cleared'; operationId: string }>
	> {
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.revokedSessions,
				this.operations,
				this.setupOperations,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					const snapshot = await this.snapshots.get(active.ownerKey);
					if (
						snapshot?.contractVersion !== undefined &&
						snapshot.contractVersion !== OFFLINE_CONTRACT_VERSION
					)
						throw new Error(
							'Reload the current application before clearing this working copy.',
						);
				}
				if (active?.key === 'active-owner' && !discardPending) {
					const count = await this.ownerPendingWorkCount(active.ownerKey);
					if (count > 0) return { kind: 'confirmation', count } as const;
				}
				return {
					kind: 'cleared',
					operationId: await this.deactivate(sessionKey),
				} as const;
			},
		);
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
			[
				this.snapshots,
				this.metadata,
				this.revokedSessions,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await Promise.all([
						this.snapshots.delete(active.ownerKey),
						this.buildOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.driveOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoMedia.where('ownerKey').equals(active.ownerKey).delete(),
						this.photoChanges
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.settingsOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.voiceCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.maintenanceOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
						this.setupOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
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

	async pendingSignOut(): Promise<Readonly<{
		operationId: string;
		sessionKey: string;
	}> | null> {
		const pending = await this.metadata.get('sign-out');
		return pending?.key === 'sign-out' && pending.state === 'pending'
			? { operationId: pending.operationId, sessionKey: pending.sessionKey }
			: null;
	}

	async completeSignOut(operationId: string): Promise<void> {
		await this.database.transaction(
			'rw',
			[this.metadata, this.revokedSessions],
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
			[this.snapshots, this.metadata],
			async () => {
				const active = await this.metadata.get('active-owner');
				if (
					active?.key !== 'active-owner' ||
					active.ownerKey !== snapshot.ownerKey ||
					active.sessionKey !== sessionKey
				)
					return false;
				const existing = await this.snapshots.get(snapshot.ownerKey);
				if (
					existing?.contractVersion !== undefined &&
					existing.contractVersion !== OFFLINE_CONTRACT_VERSION
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

	async photoView(fence: OfflineWorkspaceFence): Promise<PhotoView> {
		const current = await this.currentSnapshot(undefined, fence);
		if (!current) throw new Error('The offline Garage is unavailable.');
		const captures = await this.photoCaptures
			.where('ownerKey')
			.equals(current.ownerKey)
			.toArray();
		captures.sort(
			(a, b) =>
				a.photo.createdAt.localeCompare(b.photo.createdAt) ||
				a.operationId.localeCompare(b.operationId),
		);
		const changes = await this.photoChanges
			.where('ownerKey')
			.equals(current.ownerKey)
			.sortBy('createdAt');
		let photos = materializePhotos(current.photos ?? [], captures);
		for (const change of changes)
			photos = [
				...photos.filter((value) => value.carId !== change.carId),
				...applyPhotoChange(
					photos.filter((value) => value.carId === change.carId),
					change.command,
				),
			];
		return { photos, captures, changes };
	}
	async commitPhotoChange(
		carId: string,
		change: Exclude<PhotoMutationCommand, { kind: 'upload' }>,
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		return this.database.transaction(
			'rw',
			[
				this.metadata,
				this.snapshots,
				this.operations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const dependencies = await this.ownerOperations(fence.ownerKey);
				const parent = materializeCars(snapshot.cars, dependencies).find(
					(value) => value.id === carId,
				);
				if (!parent || parent.archivedAt)
					throw new Error('An active Car is required.');
				const view = await this.photoView(fence);
				const photos = view.photos.filter((value) => value.carId === carId);
				const replacement =
					change.kind === 'replace'
						? {
								fileName: change.file.name,
								contentType: change.file.type,
								byteSize: change.file.size,
							}
						: null;
				if (
					replacement &&
					(!['image/jpeg', 'image/png', 'image/webp'].includes(
						replacement.contentType,
					) ||
						!replacement.fileName.trim() ||
						replacement.fileName.length > 255 ||
						replacement.byteSize === 0 ||
						replacement.byteSize > 10 * 1024 * 1024)
				)
					throw new Error('Choose a valid photo.');
				const command: PhotoChange = {
					type: 'photo.change',
					carId,
					action: change.kind,
					photoId: change.kind === 'reorder' ? null : change.photo.id,
					order:
						change.kind === 'reorder'
							? change.photos.map((value) => value.id)
							: [],
					base: photoChangeBase(
						{
							action: change.kind,
							photoId: change.kind === 'reorder' ? null : change.photo.id,
						},
						photos,
					),
					replacement,
				};
				if (
					command.photoId !== null
						? !photos.some((value) => value.id === command.photoId)
						: command.order.length !== photos.length ||
							new Set(command.order).size !== photos.length ||
							command.order.some(
								(id) => !photos.some((value) => value.id === id),
							)
				)
					throw new Error(
						'The gallery changed. Reopen it before trying again.',
					);
				await this.photoChanges.add({
					ownerKey: fence.ownerKey,
					operationId: this.nextOperationId(),
					carId,
					createdAt: this.now(),
					command,
					status: 'pending',
					dependencies: [
						...dependencies
							.filter((value) => value.carId === carId)
							.map((value) => value.operationId),
						...view.captures
							.filter(
								(value) =>
									value.carId === carId &&
									(photoChangeTouchesGallery(command) ||
										value.photo.id === command.photoId),
							)
							.map((value) => value.operationId),
						...view.changes
							.filter(
								(value) =>
									value.carId === carId &&
									photoChangesOverlap(command, value.command),
							)
							.map((value) => value.operationId),
					],
					...(change.kind === 'replace' ? { blob: change.file } : {}),
				});
				return this.photoView(fence);
			},
		);
	}
	async readyPhotoChanges(
		fence: OfflineWorkspaceFence,
	): Promise<readonly PhotoChangeOperation[]> {
		const view = await this.photoView(fence);
		const pendingIds = new Set(
			[
				...(await this.ownerOperations(fence.ownerKey)),
				...view.captures,
				...view.changes,
			].map((value) => value.operationId),
		);
		return view.changes.filter(
			(value) =>
				value.status === 'pending' &&
				!value.dependencies.some((id) => pendingIds.has(id)),
		);
	}
	async recordPhotoChangeOutcome(
		outcome: PhotoChangeOutcome,
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		return this.database.transaction(
			'rw',
			[
				this.metadata,
				this.snapshots,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const operation = await this.photoChanges.get(outcome.operationId);
				if (operation?.ownerKey === fence.ownerKey) {
					if (outcome.outcome === 'applied') {
						await this.snapshots.put({
							...snapshot,
							photos: [
								...(snapshot.photos ?? []).filter(
									(value) => value.carId !== operation.carId,
								),
								...outcome.photos,
							],
						});
						await this.photoChanges.delete(operation.operationId);
						for (const photo of outcome.photos) {
							if (
								operation.command.action === 'replace' &&
								photo.id === operation.command.photoId
							)
								continue;
							const media = await this.photoMedia.get([
								fence.ownerKey,
								photo.id,
							]);
							const base = operation.command.base.find(
								(value) => value.id === photo.id,
							);
							if (media && base && (media.revision ?? 1) === base.revision)
								await this.photoMedia.put({
									...media,
									revision: photo.revision ?? 1,
								});
						}

						if (
							operation.command.photoId &&
							['replace', 'delete'].includes(operation.command.action)
						) {
							await this.photoMedia.delete([
								fence.ownerKey,
								operation.command.photoId,
							]);
							if (operation.blob)
								await this.photoMedia.put({
									ownerKey: fence.ownerKey,
									photoId: operation.command.photoId,
									blob: operation.blob,
									revision:
										outcome.photos.find(
											(value) => value.id === operation.command.photoId,
										)?.revision ?? 1,
								});
						}
						// Each queued gallery action was based on the previous local result.
						// Rebase only that dependency, preserving the remaining local sequence.
						let photos = outcome.photos;
						for (const next of await this.photoChanges
							.where('ownerKey')
							.equals(fence.ownerKey)
							.sortBy('createdAt')) {
							if (
								next.carId !== operation.carId ||
								!next.dependencies.includes(operation.operationId)
							)
								continue;
							const command = {
								...next.command,
								base: photoChangeBase(next.command, photos),
							};
							await this.photoChanges.put({
								...next,
								command,
								dependencies: next.dependencies.filter(
									(id) => id !== operation.operationId,
								),
							});
							photos = applyPhotoChange(photos, command);
						}
					} else
						await this.photoChanges.put({
							...operation,
							status:
								outcome.outcome === 'conflict' ? 'conflict' : 'needs-attention',
							feedback: outcome.error,
							remote: outcome.remote,
						});
				}
				return this.photoView(fence);
			},
		);
	}

	async resolvePhotoCapture(
		capture: PhotoCapture,
		decision: 'retry' | 'discard',
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		return this.database.transaction(
			'rw',
			[
				this.metadata,
				this.snapshots,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const stored = await this.photoCaptures.get(capture.operationId);
				if (
					!stored ||
					stored.ownerKey !== fence.ownerKey ||
					stored.status !== 'needs-attention' ||
					JSON.stringify(stored) !== JSON.stringify(capture)
				)
					throw new Error('This photo changed. Reopen its recovery actions.');
				const nextId = this.nextOperationId();
				await this.photoCaptures.delete(stored.operationId);
				await this.photoMedia.delete([fence.ownerKey, stored.photo.id]);
				if (decision === 'retry') {
					await this.photoCaptures.add({
						...stored,
						operationId: nextId,
						photo: { ...stored.photo, id: nextId },
						status: 'pending',
						feedback: undefined,
					});
					await this.photoMedia.put({
						ownerKey: fence.ownerKey,
						photoId: nextId,
						blob: stored.blob,
						revision: 1,
					});
				}
				for (const change of await this.photoChanges
					.where('ownerKey')
					.equals(fence.ownerKey)
					.toArray()) {
					if (!change.dependencies.includes(stored.operationId)) continue;
					const remap = (id: string) => (id === stored.photo.id ? nextId : id);
					await this.photoChanges.put(
						decision === 'retry'
							? {
									...change,
									dependencies: change.dependencies.map((id) =>
										id === stored.operationId ? nextId : id,
									),
									command: {
										...change.command,
										photoId:
											change.command.photoId === null
												? null
												: remap(change.command.photoId),
										order: change.command.order.map(remap),
										base: change.command.base.map((value) => ({
											...value,
											id: remap(value.id),
										})),
									},
								}
							: {
									...change,
									status: 'needs-attention',
									feedback: {
										code: 'PHOTO_CAPTURE_DISCARDED',
										message:
											'The prerequisite photo capture was discarded. Your later change remains here for review.',
									},
								},
					);
				}
				return this.photoView(fence);
			},
		);
	}

	async commitPhoto(
		carId: string,
		file: File,
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		const operationId = this.nextOperationId();
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const cars = materializeCars(
					current.cars,
					await this.ownerOperations(current.ownerKey),
				);
				const parent = cars.find((car) => car.id === carId);
				if (!parent || parent.archivedAt)
					throw new Error('An active Car is required.');
				if (
					!['image/jpeg', 'image/png', 'image/webp'].includes(file.type) ||
					file.size === 0 ||
					file.size > 10 * 1024 * 1024 ||
					!file.name.trim() ||
					file.name.length > 255
				)
					throw new Error('Choose a valid photo.');
				const view = await this.photoView(fence);
				const photos = view.photos.filter((photo) => photo.carId === carId);
				const photo: CarPhoto = {
					revision: 1,
					fileName: file.name,
					byteSize: file.size,
					id: operationId,
					carId,
					contentType: file.type,
					createdAt: new Date(
						Math.max(
							this.now(),
							...view.captures.map(
								(value) => Date.parse(value.photo.createdAt) + 1,
							),
						),
					).toISOString(),
					sortOrder: photos.length,
					isPrimary: !photos.some((photo) => photo.isPrimary),
				};
				await this.photoCaptures.add({
					ownerKey: current.ownerKey,
					operationId,
					carId,
					fileName: file.name,
					blob: file,
					photo,
					status: 'pending',
				});
				await this.photoMedia.put({
					ownerKey: current.ownerKey,
					photoId: operationId,
					blob: file,
				});
				return this.photoView(fence);
			},
		);
	}
	async readyPhotoCaptures(
		fence: OfflineWorkspaceFence,
	): Promise<readonly PhotoCapture[]> {
		const view = await this.photoView(fence);
		const dependencies = await this.ownerOperations(fence.ownerKey);
		return view.captures.filter(
			(capture) =>
				capture.status === 'pending' &&
				!dependencies.some((operation) => operation.carId === capture.carId),
		);
	}
	async recordPhotoOutcome(
		outcome: PhotoCaptureOutcome,
		photos: readonly CarPhoto[],
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.photoCaptures, this.photoChanges],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const capture = await this.photoCaptures.get(outcome.operationId);
				if (capture?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						if (
							!photos.some(
								(photo) =>
									photo.id === capture.operationId &&
									photo.carId === capture.carId,
							)
						)
							throw new Error(
								'The acknowledged photo metadata is unavailable.',
							);
						await this.snapshots.put({ ...current, photos });
						await this.photoCaptures.delete(capture.operationId);
					} else
						await this.photoCaptures.put({
							...capture,
							status: 'needs-attention',
							feedback: outcome.error,
						});
				}
				return this.photoView(fence);
			},
		);
	}
	async refreshPhotos(
		photos: readonly CarPhoto[],
		replacedPhotoId: string | undefined,
		fence: OfflineWorkspaceFence,
	): Promise<PhotoView> {
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				await this.snapshots.put({ ...current, photos });
				if (replacedPhotoId)
					await this.photoMedia.delete([fence.ownerKey, replacedPhotoId]);
				return this.photoView(fence);
			},
		);
	}

	async retainPhoto(
		photoId: string,
		blob: Blob,
		fence: OfflineWorkspaceFence,
		revision = 1,
	): Promise<void> {
		await this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
			],
			async () => {
				const view = await this.photoView(fence);
				if (!view.photos.some((photo) => photo.id === photoId))
					throw new Error('Photo metadata is unavailable.');
				const snapshot = await this.currentSnapshot(undefined, fence);
				const canonical =
					snapshot?.photos?.find((photo) => photo.id === photoId) ??
					view.photos.find((photo) => photo.id === photoId);
				if ((canonical?.revision ?? 1) !== revision)
					throw new Error('The original belongs to an earlier photo revision.');
				await this.photoMedia.put({
					ownerKey: fence.ownerKey,
					photoId,
					blob,
					revision,
				});
			},
		);
	}
	async retainedPhoto(
		photoId: string,
		fence: OfflineWorkspaceFence,
	): Promise<Blob | null> {
		const view = await this.photoView(fence);
		if (!view.photos.some((photo) => photo.id === photoId)) return null;
		const replacement = [...view.changes]
			.reverse()
			.find((value) => value.command.photoId === photoId && value.blob);
		if (replacement?.blob) return replacement.blob;
		const media = await this.photoMedia.get([fence.ownerKey, photoId]);
		const snapshot = await this.currentSnapshot(undefined, fence);
		const canonical =
			snapshot?.photos?.find((photo) => photo.id === photoId) ??
			view.photos.find((photo) => photo.id === photoId);
		return media && (media.revision ?? 1) === (canonical?.revision ?? 1)
			? media.blob
			: null;
	}

	async maintenanceSyncView(
		fence: OfflineWorkspaceFence,
	): Promise<MaintenanceView> {
		const current = await this.currentSnapshot(undefined, fence);
		if (!current) throw new Error('The offline Garage is unavailable.');
		const operations = await this.maintenanceOperations
			.where('ownerKey')
			.equals(current.ownerKey)
			.sortBy('sequence');
		return maintenanceView(
			current.maintenance ?? {
				collections: [],
				components: [],
				timezone: 'UTC',
			},
			operations,
		);
	}
	async refreshMaintenance(
		incoming: MaintenanceSnapshot,
		fence: OfflineWorkspaceFence,
	): Promise<MaintenanceView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.maintenanceOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const collections = new Map(
					(current.maintenance?.collections ?? []).map((collection) => [
						collection.carId,
						collection,
					]),
				);
				for (const collection of incoming.collections) {
					const previous = collections.get(collection.carId);
					if (!previous || collection.version >= previous.version)
						collections.set(collection.carId, collection);
				}
				await this.snapshots.put({
					...current,
					maintenance: { ...incoming, collections: [...collections.values()] },
				});
				return this.maintenanceSyncView(fence);
			},
		);
	}

	async commitMaintenance(
		command: MaintenanceCommand,
		fence: OfflineWorkspaceFence,
	): Promise<MaintenanceView> {
		const operationId = this.nextOperationId();
		const entityId = this.nextOperationId();
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.driveOperations,
				this.buildOperations,
				this.maintenanceOperations,
			],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const view = await this.maintenanceSyncView(fence);
				const [carOperations, driveOperations, buildOperations] =
					await Promise.all([
						this.ownerOperations(current.ownerKey),
						this.ownerDriveOperations(current.ownerKey),
						this.ownerBuildOperations(current.ownerKey),
					]);
				const drives = materializeDriveCollections(
					current.driveCollections ?? [],
					driveOperations,
				);
				const built = buildMaintenanceOperation(command, view, {
					ownerKey: current.ownerKey,
					operationId,
					entityId,
					createdAt: new Date(this.now()).toISOString(),
					sessionCounts: new Map(
						drives.map((collection) => [
							collection.carId,
							collection.sessions.filter((session) => !session.deletedAt)
								.length,
						]),
					),
					// Consumables do not reference Drive usage or Service records.
					// Only their Car and earlier intent for the same entry are prerequisites.
					dependencies:
						command.kind === 'save' || command.kind === 'change'
							? carOperations
							: [...carOperations, ...driveOperations],
				});
				const parent = materializeCars(current.cars, carOperations).find(
					(car) => car.id === built.carId,
				);
				if (!parent || parent.archivedAt)
					throw new Error('An active Car is required.');
				const componentId =
					built.command.entity === 'consumable'
						? null
						: built.command.input.componentId;
				const componentDependencies = buildOperations
					.filter((operation) => operation.command.componentId === componentId)
					.map((operation) => operation.operationId);
				const operation = {
					...built,
					dependencies: [...built.dependencies, ...componentDependencies],
				};
				await this.maintenanceOperations.add(operation);
				return maintenanceView(view.canonical, [...view.operations, operation]);
			},
		);
	}
	async readyMaintenanceOperations(
		fence: OfflineWorkspaceFence,
	): Promise<readonly MaintenanceOperation[]> {
		return this.database.transaction(
			'r',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.driveOperations,
				this.buildOperations,
				this.maintenanceOperations,
			],
			async () => {
				const view = await this.maintenanceSyncView(fence);
				const dependencies = [
					...(await this.ownerOperations(fence.ownerKey)),
					...(await this.ownerDriveOperations(fence.ownerKey)),
					...(await this.ownerBuildOperations(fence.ownerKey)),
					...view.operations,
				];
				const ids = new Set(
					dependencies.map((operation) => operation.operationId),
				);
				return view.operations.filter(
					(operation) =>
						operation.status === 'pending' &&
						!operation.dependencies.some((id) => ids.has(id)),
				);
			},
		);
	}
	async recordMaintenanceOutcome(
		outcome: MaintenanceRemoteOutcome,
		fence: OfflineWorkspaceFence,
	): Promise<MaintenanceView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.maintenanceOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const view = await this.maintenanceSyncView(fence);
				const operation = await this.maintenanceOperations.get(
					outcome.operationId,
				);
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						const existing = view.canonical.collections.find(
							(collection) => collection.carId === outcome.collection.carId,
						);
						const accepted =
							existing && existing.version > outcome.collection.version
								? existing
								: outcome.collection;
						const collections = [
							...view.canonical.collections.filter(
								(collection) => collection.carId !== accepted.carId,
							),
							accepted,
						];
						await this.snapshots.put({
							...current,
							maintenance: { ...view.canonical, collections },
						});
						await this.maintenanceOperations.delete(operation.operationId);
						const dependents = await this.maintenanceOperations
							.where('ownerKey')
							.equals(current.ownerKey)
							.toArray();
						await this.maintenanceOperations.bulkPut(
							dependents.map((dependent) =>
								rebaseMaintenanceOperation(
									dependent,
									operation.operationId,
									accepted,
								),
							),
						);
					} else
						await this.maintenanceOperations.put({
							...operation,
							status:
								outcome.outcome === 'conflict' ? 'conflict' : 'needs-attention',
							feedback: outcome.error,
							...(outcome.outcome === 'conflict'
								? { remote: outcome.remote }
								: {}),
						});
				}
				return this.maintenanceSyncView(fence);
			},
		);
	}

	async carSyncView(): Promise<CarSyncView | null> {
		const current = await this.currentSnapshot();
		if (!current) return null;
		const operations = await this.ownerOperations(current.ownerKey);
		return this.view(current.cars, operations);
	}

	async setupSyncView(): Promise<SetupSyncView | null> {
		const current = await this.currentSnapshot();
		if (!current) return null;
		const operations = await this.ownerSetupOperations(current.ownerKey);
		return this.setupView(current.setupCollections ?? [], operations);
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
			[this.snapshots, this.metadata, this.operations],
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

	async commitSetup(
		command: SetupSyncCommand,
		fence: OfflineWorkspaceFence,
	): Promise<CommittedSetupSyncOperation> {
		const operationId = this.nextOperationId();
		const createsSnapshot =
			command.type === 'create' ||
			command.type === 'copy' ||
			command.type === 'change';
		const setupId = createsSnapshot ? this.nextOperationId() : undefined;
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const [carOperations, setupOperations] = await Promise.all([
					this.ownerOperations(current.ownerKey),
					this.ownerSetupOperations(current.ownerKey),
				]);
				const collections = materializeSetupCollections(
					current.setupCollections ?? [],
					setupOperations,
				);
				const built = buildSetupSyncOperation(
					command,
					collections,
					setupOperations,
					{
						ownerKey: current.ownerKey,
						operationId,
						setupId,
						createdAt: new Date(this.now()).toISOString(),
						carDependencies: carOperations
							.filter((operation) => operation.carId === command.carId)
							.map((operation) => operation.operationId),
					},
				);
				await this.setupOperations.add(built.operation);
				return {
					...built,
					view: this.setupView(current.setupCollections ?? [], [
						...setupOperations,
						built.operation,
					]),
				};
			},
		);
	}

	private buildView(
		canonicalCollections: readonly BuildSyncCollection[],
		operations: readonly BuildSyncOperation[],
	): BuildSyncView {
		return {
			canonicalCollections,
			collections: materializeBuildCollections(
				canonicalCollections,
				operations,
			),
			operations,
		};
	}

	private ownerBuildOperations(
		ownerKey: string,
	): Promise<BuildSyncOperation[]> {
		return this.buildOperations.where('ownerKey').equals(ownerKey).toArray();
	}

	async buildSyncView(): Promise<BuildSyncView | null> {
		const current = await this.currentSnapshot();
		if (!current) return null;
		return this.buildView(
			current.buildCollections ?? [],
			await this.ownerBuildOperations(current.ownerKey),
		);
	}

	async commitBuild(
		command: BuildSyncCommand,
		fence: OfflineWorkspaceFence,
	): Promise<
		Readonly<{
			operation: BuildSyncOperation;
			collection: BuildSyncCollection;
			view: BuildSyncView;
		}>
	> {
		const operationId = this.nextOperationId();
		const componentId = this.nextOperationId();
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.operations, this.buildOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const operations = await this.ownerBuildOperations(current.ownerKey);
				const carOperations = await this.ownerOperations(current.ownerKey);
				const cars = materializeCars(current.cars, carOperations);
				if (!cars.some((car) => car.id === command.carId && !car.archivedAt))
					throw new Error('Restore this Car before changing its build.');
				const canonical = current.buildCollections ?? [];
				const built = buildBuildSyncOperation(
					command,
					materializeBuildCollections(canonical, operations),
					operations,
					{
						ownerKey: current.ownerKey,
						operationId,
						componentId,
						createdAt: new Date(this.now()).toISOString(),
						carDependencies: carOperations
							.filter((operation) => operation.carId === command.carId)
							.map((operation) => operation.operationId),
					},
				);
				await this.buildOperations.add(built.operation);
				return {
					...built,
					view: this.buildView(canonical, [...operations, built.operation]),
				};
			},
		);
	}

	async readyBuildOperations(): Promise<readonly BuildSyncOperation[]> {
		return this.database.transaction(
			'r',
			[this.snapshots, this.metadata, this.operations, this.buildOperations],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) return [];
				const operations = await this.ownerBuildOperations(current.ownerKey);
				const carOperations = await this.ownerOperations(current.ownerKey);
				return readyBuildSyncOperations(
					operations,
					new Set(
						[...operations, ...carOperations].map(
							(operation) => operation.operationId,
						),
					),
				);
			},
		);
	}

	async recordBuildOutcome(
		outcome: BuildSyncRemoteOutcome,
	): Promise<BuildSyncView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.buildOperations],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) throw new Error('The offline Garage is unavailable.');
				let canonical = current.buildCollections ?? [];
				const operation = await this.buildOperations.get(outcome.operationId);
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						canonical = mergeBuildCollection(canonical, outcome.collection);
						await this.snapshots.put({
							...current,
							buildCollections: canonical,
						});
						await this.buildOperations.delete(operation.operationId);
						const dependents = await this.ownerBuildOperations(
							current.ownerKey,
						);
						await this.buildOperations.bulkPut(
							dependents.map((candidate) =>
								rebaseBuildSyncOperation(
									candidate,
									operation.operationId,
									outcome.collection,
								),
							),
						);
					} else {
						await this.buildOperations.put({
							...operation,
							status:
								outcome.outcome === 'rejected' ? 'needs-attention' : 'conflict',
							feedback: outcome.error,
							...(outcome.outcome === 'conflict'
								? { remote: outcome.remote }
								: {}),
						});
					}
				}
				return this.buildView(
					canonical,
					await this.ownerBuildOperations(current.ownerKey),
				);
			},
		);
	}

	async mergeBuildCollection(
		collection: BuildSyncCollection,
		fence: OfflineWorkspaceFence,
	): Promise<BuildSyncView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.buildOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const canonical = mergeBuildCollection(
					current.buildCollections ?? [],
					collection,
				);
				await this.snapshots.put({ ...current, buildCollections: canonical });
				return this.buildView(
					canonical,
					await this.ownerBuildOperations(current.ownerKey),
				);
			},
		);
	}

	private driveView(
		canonicalCollections: readonly DriveSyncCollection[],
		operations: readonly DriveSyncOperation[],
	): DriveSyncView {
		return {
			canonicalCollections,
			collections: materializeDriveCollections(
				canonicalCollections,
				operations,
			),
			operations,
		};
	}

	private ownerDriveOperations(
		ownerKey: string,
	): Promise<DriveSyncOperation[]> {
		return this.driveOperations.where('ownerKey').equals(ownerKey).toArray();
	}

	async driveSyncView(): Promise<DriveSyncView | null> {
		const current = await this.currentSnapshot();
		if (!current) return null;
		return this.driveView(
			current.driveCollections ?? [],
			await this.ownerDriveOperations(current.ownerKey),
		);
	}

	async commitDrive(
		command: DriveSyncCommand,
		fence: OfflineWorkspaceFence,
	): Promise<
		Readonly<{
			operation: DriveSyncOperation;
			collection: DriveSyncCollection;
			view: DriveSyncView;
		}>
	> {
		const operationId = this.nextOperationId();
		const sessionId = this.nextOperationId();
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.operations, this.driveOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const operations = await this.ownerDriveOperations(current.ownerKey);
				const carOperations = await this.ownerOperations(current.ownerKey);
				const cars = materializeCars(current.cars, carOperations);
				if (!cars.some((car) => car.id === command.carId && !car.archivedAt))
					throw new Error('Restore this Car before recording Drive sessions.');
				const canonical = current.driveCollections ?? [];
				const built = buildDriveSyncOperation(
					command,
					materializeDriveCollections(canonical, operations),
					operations,
					{
						ownerKey: current.ownerKey,
						operationId,
						sessionId,
						createdAt: new Date(this.now()).toISOString(),
						carDependencies: carOperations
							.filter((operation) => operation.carId === command.carId)
							.map((operation) => operation.operationId),
					},
				);
				await this.driveOperations.add(built.operation);
				return {
					...built,
					view: this.driveView(canonical, [...operations, built.operation]),
				};
			},
		);
	}

	async readyDriveOperations(): Promise<readonly DriveSyncOperation[]> {
		return this.database.transaction(
			'r',
			[this.snapshots, this.metadata, this.operations, this.driveOperations],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) return [];
				const operations = await this.ownerDriveOperations(current.ownerKey);
				const carOperations = await this.ownerOperations(current.ownerKey);
				return readyDriveSyncOperations(
					operations,
					new Set(
						[...operations, ...carOperations].map(
							(operation) => operation.operationId,
						),
					),
				);
			},
		);
	}

	async recordDriveOutcome(
		outcome: DriveSyncRemoteOutcome,
	): Promise<DriveSyncView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.driveOperations],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) throw new Error('The offline Garage is unavailable.');
				let canonical = current.driveCollections ?? [];
				const operation = await this.driveOperations.get(outcome.operationId);
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						canonical = mergeDriveCollection(canonical, outcome.collection);
						await this.snapshots.put({
							...current,
							driveCollections: canonical,
						});
						await this.driveOperations.delete(operation.operationId);
						const dependents = await this.ownerDriveOperations(
							current.ownerKey,
						);
						await this.driveOperations.bulkPut(
							dependents.map((candidate) =>
								rebaseDriveSyncOperation(
									candidate,
									operation.operationId,
									outcome.collection,
								),
							),
						);
					} else {
						await this.driveOperations.put({
							...operation,
							status:
								outcome.outcome === 'rejected' ? 'needs-attention' : 'conflict',
							feedback: outcome.error,
							...(outcome.outcome === 'conflict'
								? { remote: outcome.remote }
								: {}),
						});
					}
				}
				return this.driveView(
					canonical,
					await this.ownerDriveOperations(current.ownerKey),
				);
			},
		);
	}

	async mergeDriveCollection(
		collection: DriveSyncCollection,
		fence: OfflineWorkspaceFence,
	): Promise<DriveSyncView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.driveOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const canonical = mergeDriveCollection(
					current.driveCollections ?? [],
					collection,
				);
				await this.snapshots.put({ ...current, driveCollections: canonical });
				return this.driveView(
					canonical,
					await this.ownerDriveOperations(current.ownerKey),
				);
			},
		);
	}

	async readyCarOperations(): Promise<readonly CarSyncOperation[]> {
		const view = await this.carSyncView();
		return view ? readyCarSyncOperations(view.operations) : [];
	}

	async readySetupOperations(): Promise<readonly SetupSyncOperation[]> {
		return this.database.transaction(
			'r',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) return [];
				const [carOperations, setupOperations] = await Promise.all([
					this.ownerOperations(current.ownerKey),
					this.ownerSetupOperations(current.ownerKey),
				]);
				return readySetupSyncOperations(
					setupOperations,
					new Set([
						...carOperations.map((operation) => operation.operationId),
						...setupOperations.map((operation) => operation.operationId),
					]),
				);
			},
		);
	}

	async recordCarOutcome(outcome: CarSyncRemoteOutcome): Promise<CarSyncView> {
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
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
						const setupCollection = (current.setupCollections ?? []).find(
							(collection) => collection.carId === operation.carId,
						) ?? {
							carId: operation.carId,
							currentSetupId: null,
							currentSetupVersion: 0,
							setups: [],
						};
						const setupDependents = await this.ownerSetupOperations(
							current.ownerKey,
						);
						await this.setupOperations.bulkPut(
							setupDependents.map((candidate) =>
								rebaseSetupSyncOperation(
									candidate,
									operation.operationId,
									setupCollection,
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

	async recordSetupOutcome(
		outcome: SetupSyncRemoteOutcome,
	): Promise<SetupSyncView> {
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const current = await this.currentSnapshot();
				if (!current) throw new Error('The offline Garage is unavailable.');
				let canonicalCollections = current.setupCollections ?? [];
				const operation = await this.setupOperations.get(outcome.operationId);
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						const incoming: SetupSyncCollection = {
							carId: operation.carId,
							currentSetupId: outcome.currentSetupId,
							currentSetupVersion: outcome.currentSetupVersion,
							setups: [outcome.setup],
						};
						canonicalCollections = this.mergeSetupCollections(
							canonicalCollections,
							incoming,
						);
						await Promise.all([
							this.snapshots.put({
								...current,
								setupCollections: canonicalCollections,
							}),
							this.setupOperations.delete(operation.operationId),
						]);
						const acknowledged = canonicalCollections.find(
							(collection) => collection.carId === operation.carId,
						) as SetupSyncCollection;
						const dependents = await this.ownerSetupOperations(
							current.ownerKey,
						);
						await this.setupOperations.bulkPut(
							dependents.map((candidate) =>
								rebaseSetupSyncOperation(
									candidate,
									operation.operationId,
									acknowledged,
								),
							),
						);
					} else if (outcome.outcome === 'rejected') {
						await this.setupOperations.put({
							...operation,
							status: 'needs-attention',
							feedback: outcome.error,
						});
					} else {
						await this.setupOperations.put({
							...operation,
							status: 'conflict',
							feedback: outcome.error,
							remote: outcome.remote,
						});
					}
				}
				return this.setupView(
					canonicalCollections,
					await this.ownerSetupOperations(current.ownerKey),
				);
			},
		);
	}

	async replaceCars(cars: readonly GarageCar[]): Promise<CarSyncView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.operations],
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
			[this.snapshots, this.metadata, this.operations],
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

	async mergeSetupCollection(
		collection: SetupSyncCollection,
		fence: OfflineWorkspaceFence,
	): Promise<SetupSyncView> {
		return this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current) throw new Error('The offline Garage is unavailable.');
				const canonicalCollections = this.mergeSetupCollections(
					current.setupCollections ?? [],
					collection,
				);
				await this.snapshots.put({
					...current,
					setupCollections: canonicalCollections,
				});
				return this.setupView(
					canonicalCollections,
					await this.ownerSetupOperations(current.ownerKey),
				);
			},
		);
	}

	async restoreCurrent(
		now = new Date(this.now()),
	): Promise<OfflineGarageSnapshot | null> {
		const active = await this.metadata.get('active-owner');
		if (active?.key !== 'active-owner') return null;
		const snapshot = await this.currentSnapshot(now, active);
		if (!snapshot) return null;
		const [operations, setupOperations] = await Promise.all([
			this.ownerOperations(snapshot.ownerKey),
			this.ownerSetupOperations(snapshot.ownerKey),
		]);
		return {
			...snapshot,
			sessionKey: active.sessionKey,
			cars: materializeCars(snapshot.cars, operations),
			driveCollections: materializeDriveCollections(
				snapshot.driveCollections ?? [],
				await this.ownerDriveOperations(snapshot.ownerKey),
			),
			buildCollections: materializeBuildCollections(
				snapshot.buildCollections ?? [],
				await this.ownerBuildOperations(snapshot.ownerKey),
			),
			setupCollections: materializeSetupCollections(
				snapshot.setupCollections ?? [],
				setupOperations,
			),
		};
	}

	async settingsSyncView(): Promise<SettingsView | null> {
		const current = await this.currentSnapshot();
		if (!current?.settings) return null;
		return settingsView(
			current.settings,
			await this.settingsOperations
				.where('ownerKey')
				.equals(current.ownerKey)
				.sortBy('createdAt'),
		);
	}
	async commitSettings(
		command: SettingsCommand,
		fence: OfflineWorkspaceFence,
	): Promise<SettingsView> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.settingsOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current?.settings)
					throw new Error('Offline Settings are unavailable.');
				const operations = await this.settingsOperations
					.where('ownerKey')
					.equals(current.ownerKey)
					.sortBy('createdAt');
				const operation: SettingsOperation = {
					operationId: this.nextOperationId(),
					ownerKey: current.ownerKey,
					createdAt: new Date(this.now()).toISOString(),
					command,
					dependencies: settingsDependencies(command, operations),
					status: 'pending',
				};
				await this.settingsOperations.add(operation);
				return settingsView(current.settings, [...operations, operation]);
			},
		);
	}
	async recordSettingsOutcome(
		outcome: SettingsRemoteOutcome,
		fence: OfflineWorkspaceFence,
	): Promise<SettingsView | null> {
		return this.database.transaction(
			'rw',
			[this.snapshots, this.metadata, this.settingsOperations],
			async () => {
				const current = await this.currentSnapshot(undefined, fence);
				if (!current?.settings) return null;
				const operation = await this.settingsOperations.get(
					outcome.operationId,
				);
				let canonical = current.settings;
				if (operation?.ownerKey === current.ownerKey) {
					if (outcome.outcome === 'applied') {
						canonical = acknowledgeSettings(canonical, outcome);
						await this.snapshots.put({ ...current, settings: canonical });
						await this.settingsOperations.delete(operation.operationId);
					} else {
						await this.settingsOperations.put({
							...operation,
							status:
								outcome.outcome === 'conflict' ? 'conflict' : 'needs-attention',
							feedback: outcome.error,
							...(outcome.outcome === 'conflict'
								? { remote: outcome.remote }
								: {}),
						});
					}
				}
				return settingsView(
					canonical,
					await this.settingsOperations
						.where('ownerKey')
						.equals(current.ownerKey)
						.sortBy('createdAt'),
				);
			},
		);
	}

	async resolveSyncReview(
		review: SyncReview,
		decision: ReviewDecision,
		fence: OfflineWorkspaceFence,
	): Promise<void> {
		const tables = this.reviewTables();
		const operationId = this.nextOperationId();
		await this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.voiceCaptures,
				this.photoMedia,
				...Object.values(tables),
			],
			async () => {
				const snapshot = await this.currentSnapshot(undefined, fence);
				if (!snapshot) throw new Error('The offline Garage is unavailable.');
				const table = tables[review.family];
				const stored = await table.get(review.operation.operationId);
				if (
					!stored ||
					stored.ownerKey !== fence.ownerKey ||
					stored.status === 'pending' ||
					JSON.stringify(stored) !== JSON.stringify(review.operation)
				)
					throw new Error('This change was updated. Open its review again.');
				await this.mergeReviewedRemote(review, snapshot);
				await table.delete(stored.operationId);
				if (decision === 'device')
					await table.add(retryReviewedOperation(review, operationId));
				const message =
					'The prerequisite device change was discarded. Review this change before retrying.';
				for (const [family, dependentTable] of Object.entries(tables)) {
					const dependents = await dependentTable
						.where('ownerKey')
						.equals(fence.ownerKey)
						.filter((candidate) =>
							candidate.dependencies.includes(stored.operationId),
						)
						.toArray();
					for (const dependent of dependents) {
						await dependentTable.put(
							decision === 'device'
								? {
										...dependent,
										dependencies: dependent.dependencies.map((id) =>
											id === stored.operationId ? operationId : id,
										),
									}
								: ({
										...dependent,
										status: 'needs-attention',
										feedback:
											family === 'settings'
												? message
												: { code: 'PREREQUISITE_DISCARDED', message },
									} as ReviewOperation),
						);
					}
				}
				const voices = await this.voiceCaptures
					.where('ownerKey')
					.equals(fence.ownerKey)
					.filter((capture) =>
						capture.dependencies.includes(stored.operationId),
					)
					.toArray();
				for (const capture of voices)
					await this.voiceCaptures.put(
						decision === 'device'
							? {
									...capture,
									dependencies: capture.dependencies.map((id) =>
										id === stored.operationId ? operationId : id,
									),
								}
							: { ...capture, status: 'failed', error: message },
					);
			},
		);
	}
	private reviewTables(): Readonly<
		Record<ReviewFamily, Table<ReviewOperation, string>>
	> {
		return {
			car: this.operations as Table<ReviewOperation, string>,
			setup: this.setupOperations as Table<ReviewOperation, string>,
			build: this.buildOperations as Table<ReviewOperation, string>,
			drive: this.driveOperations as Table<ReviewOperation, string>,
			maintenance: this.maintenanceOperations as Table<ReviewOperation, string>,
			settings: this.settingsOperations as Table<ReviewOperation, string>,
			photo: this.photoChanges as Table<ReviewOperation, string>,
		};
	}
	private async mergeReviewedRemote(
		review: SyncReview,
		snapshot: OfflineGarageSnapshot,
	): Promise<void> {
		switch (review.family) {
			case 'photo':
				if (review.operation.remote)
					for (const photo of review.operation.remote)
						await this.photoMedia.delete([snapshot.ownerKey, photo.id]);
				if (review.operation.remote)
					await this.snapshots.put({
						...snapshot,
						photos: [
							...(snapshot.photos ?? []).filter(
								(value) => value.carId !== review.operation.carId,
							),
							...review.operation.remote,
						],
					});
				return;
			case 'car':
				if (review.operation.remote)
					await this.snapshots.put({
						...snapshot,
						cars: this.mergeCanonicalCars(snapshot.cars, [
							review.operation.remote,
						]),
					});
				return;
			case 'setup': {
				const remote = review.operation.remote;
				if (remote)
					await this.snapshots.put({
						...snapshot,
						setupCollections: this.mergeSetupCollections(
							snapshot.setupCollections ?? [],
							{
								carId: review.operation.carId,
								currentSetupId: remote.currentSetupId,
								currentSetupVersion: remote.currentSetupVersion,
								setups: remote.setup ? [remote.setup] : [],
							},
						),
					});
				return;
			}
			case 'build':
				if (review.operation.remote)
					await this.snapshots.put({
						...snapshot,
						buildCollections: mergeBuildCollection(
							snapshot.buildCollections ?? [],
							review.operation.remote,
						),
					});
				return;
			case 'drive':
				if (review.operation.remote)
					await this.snapshots.put({
						...snapshot,
						driveCollections: mergeDriveCollection(
							snapshot.driveCollections ?? [],
							review.operation.remote,
						),
					});
				return;
			case 'maintenance': {
				const remote = review.operation.remote;
				if (remote && snapshot.maintenance) {
					const current = snapshot.maintenance.collections.find(
						(collection) => collection.carId === remote.carId,
					);
					if (!current || remote.version >= current.version)
						await this.snapshots.put({
							...snapshot,
							maintenance: {
								...snapshot.maintenance,
								collections: [
									...snapshot.maintenance.collections.filter(
										(collection) => collection.carId !== remote.carId,
									),
									remote,
								],
							},
						});
				}
				return;
			}
			case 'settings':
				if (review.operation.remote !== undefined && snapshot.settings)
					await this.snapshots.put({
						...snapshot,
						settings: {
							...snapshot.settings,
							timezone: review.operation.remote,
						},
					});
		}
	}

	close(): void {
		this.database.close();
	}

	private async invalidateActiveOwner(): Promise<void> {
		await this.database.transaction(
			'rw',
			[
				this.snapshots,
				this.metadata,
				this.revokedSessions,
				this.operations,
				this.setupOperations,
				this.buildOperations,
				this.driveOperations,
				this.photoCaptures,
				this.photoChanges,
				this.photoMedia,
				this.settingsOperations,
				this.voiceCaptures,
				this.maintenanceOperations,
			],
			async () => {
				const active = await this.metadata.get('active-owner');
				if (active?.key === 'active-owner') {
					await Promise.all([
						this.snapshots.delete(active.ownerKey),
						this.buildOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.driveOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.photoMedia.where('ownerKey').equals(active.ownerKey).delete(),
						this.photoChanges
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.settingsOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.voiceCaptures
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.maintenanceOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
						this.operations.where('ownerKey').equals(active.ownerKey).delete(),
						this.setupOperations
							.where('ownerKey')
							.equals(active.ownerKey)
							.delete(),
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
		if (
			!snapshot ||
			(snapshot.contractVersion !== undefined &&
				snapshot.contractVersion !== OFFLINE_CONTRACT_VERSION) ||
			Date.parse(snapshot.offlineUntil) <= now.valueOf()
		)
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

	private ownerSetupOperations(
		ownerKey: string,
	): Promise<SetupSyncOperation[]> {
		return this.setupOperations
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

	private setupView(
		canonicalCollections: readonly SetupSyncCollection[],
		operations: readonly SetupSyncOperation[],
	): SetupSyncView {
		return {
			canonicalCollections,
			collections: materializeSetupCollections(
				canonicalCollections,
				operations,
			),
			operations,
		};
	}

	private mergeSetupCollections(
		current: readonly SetupSyncCollection[],
		incoming: SetupSyncCollection,
	): readonly SetupSyncCollection[] {
		const existing = current.find(
			(collection) => collection.carId === incoming.carId,
		);
		if (!existing) return [...current, incoming];
		const setups = new Map(existing.setups.map((setup) => [setup.id, setup]));
		for (const candidate of incoming.setups) {
			const previous = setups.get(candidate.id);
			if (
				!previous ||
				previous.version === undefined ||
				(candidate.version !== undefined &&
					candidate.version >= previous.version)
			)
				setups.set(candidate.id, candidate);
		}
		const selection =
			incoming.currentSetupVersion >= existing.currentSetupVersion
				? incoming
				: existing;
		const merged: SetupSyncCollection = {
			carId: existing.carId,
			currentSetupId: selection.currentSetupId,
			currentSetupVersion: selection.currentSetupVersion,
			setups: [...setups.values()],
		};
		return current.map((collection) =>
			collection.carId === incoming.carId ? merged : collection,
		);
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
