import { describe, expect, it } from 'vitest';
import { canOpenOfflineRoute } from './offline-route-access';

describe('offline route capabilities', () => {
	it.each([
		'garage',
		'settings',
		'maintenance',
		'garage/car-1/build',
		'garage/car-1/photos',
		'garage/car-1/voice',
		'garage/car-1/drive-sessions',
		'garage/car-1/overview',
		'garage/car-1/setups',
		'offline-unavailable',
	])('admits the delivered route %s', (path) =>
		expect(canOpenOfflineRoute(path.split('/'))).toBe(true),
	);
	it.each([
		'',
		'track-maps',
		'garage/car-1/runs',
		'garage/car-1/setups/unknown',
		'other/car-1/overview',
	])('blocks the undelivered route %s', (path) =>
		expect(canOpenOfflineRoute(path.split('/'))).toBe(false),
	);
});
