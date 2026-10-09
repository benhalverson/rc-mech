import type { OfflineGarageSnapshot } from './offline-garage-storage';

/** Increment when a shell can no longer safely read the preceding working copy. */
export const OFFLINE_CONTRACT_VERSION = 2;

/**
 * Admission check used when restoring a prepared snapshot. Requires this client
 * contract version and every required collection, because opening IndexedDB alone
 * does not prove that an older/partial working copy supports the delivered routes.
 */
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
