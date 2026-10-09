import type { OfflineGarageSnapshot } from './offline-garage-storage';

/** Increment when a shell can no longer safely read the preceding working copy. */
export const OFFLINE_CONTRACT_VERSION = 2;

export const hasCompleteOfflineContract = (
	snapshot: OfflineGarageSnapshot,
): boolean =>
	snapshot.contractVersion === OFFLINE_CONTRACT_VERSION &&
	[
		snapshot.setupCollections,
		snapshot.buildCollections,
		snapshot.driveCollections,
		snapshot.photos,
		snapshot.voiceUpdates,
	].every(Array.isArray) &&
	Boolean(snapshot.settings && snapshot.maintenance);
