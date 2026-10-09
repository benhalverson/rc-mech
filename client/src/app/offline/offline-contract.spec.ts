import { expect, it } from 'vitest';
import {
	hasCompleteOfflineContract,
	OFFLINE_CONTRACT_VERSION,
} from './offline-contract';
import type { OfflineGarageSnapshot } from './offline-garage-storage';

const snapshot: OfflineGarageSnapshot = {
	contractVersion: OFFLINE_CONTRACT_VERSION,
	ownerKey: 'owner',
	ownerEmail: 'owner@example.test',
	offlineUntil: '2099-01-01',
	preparedAt: '2026-10-09',
	cars: [],
	setupCollections: [],
	buildCollections: [],
	driveCollections: [],
	photos: [],
	voiceUpdates: [],
	settings: {
		timezone: 'UTC',
		invites: { allowance: 5, used: 0, remaining: 5, codes: [] },
	},
	maintenance: { timezone: 'UTC', collections: [], components: [] },
};
it('accepts a complete contract and rejects older, newer and incomplete working copies without changing them', () => {
	expect(hasCompleteOfflineContract(snapshot)).toBe(true);
	for (const key of [
		'contractVersion',
		'setupCollections',
		'buildCollections',
		'driveCollections',
		'photos',
		'voiceUpdates',
		'settings',
		'maintenance',
	] as const) {
		const incomplete = { ...snapshot, [key]: undefined };
		expect(hasCompleteOfflineContract(incomplete)).toBe(false);
		expect(incomplete[key]).toBeUndefined();
	}
	expect(hasCompleteOfflineContract({ ...snapshot, contractVersion: 99 })).toBe(
		false,
	);
});
