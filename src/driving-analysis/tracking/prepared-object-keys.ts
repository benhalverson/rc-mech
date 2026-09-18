export function preparedObjectKeys(preparedMediaId: string) {
	return [
		`prepared/${preparedMediaId}/track-view.mp4`,
		`prepared/${preparedMediaId}/frame-manifest.json.gz`,
	] as const;
}
