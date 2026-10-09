/** Routes backed by the complete shared offline working copy. */
export const canOpenOfflineRoute = (paths: readonly string[]): boolean =>
	(paths.length === 1 &&
		['garage', 'maintenance', 'settings', 'offline-unavailable'].includes(
			paths[0],
		)) ||
	(paths.length === 3 &&
		paths[0] === 'garage' &&
		[
			'overview',
			'setups',
			'build',
			'photos',
			'drive-sessions',
			'voice',
		].includes(paths[2]));
