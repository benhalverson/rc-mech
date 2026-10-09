/**
 * Allowlist consulted by session admission for routes backed by this client
 * version's prepared working copy. Keep it aligned with delivered offline slices;
 * a cached shell alone is not evidence that an arbitrary protected route works.
 */
export const canOpenOfflineRoute = (paths: readonly string[]): boolean =>
	(paths.length === 1 &&
		(paths[0] === 'garage' || paths[0] === 'offline-unavailable')) ||
	(paths.length === 3 &&
		paths[0] === 'garage' &&
		(paths[2] === 'overview' || paths[2] === 'setups'));
