/** Delivered offline slices only; expand alongside each verified feature slice. */
export const canOpenOfflineRoute = (paths: readonly string[]): boolean =>
	(paths.length === 1 &&
		(paths[0] === 'garage' || paths[0] === 'offline-unavailable')) ||
	(paths.length === 3 &&
		paths[0] === 'garage' &&
		(paths[2] === 'overview' || paths[2] === 'setups'));
