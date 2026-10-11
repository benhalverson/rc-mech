type PreparationInput = Readonly<{
	runId: string;
	raceVideoId: string;
	sourceByteCount: number;
	windowStartTimestampMs: number;
	windowEndTimestampMs: number;
}>;

/** Match the media service's sorted JSON request digest, excluding correlationId. */
export const digestPreparationInput = async (
	input: PreparationInput,
	preparedMediaId: string,
): Promise<string> => {
	const payload = JSON.stringify({
		caseId: input.runId,
		contractVersion: 'subject-tracking.v1',
		input: {
			expectedByteCount: input.sourceByteCount,
			stagedMediaId: input.raceVideoId,
		},
		pipelineVersion: 'subject-tracking.v1',
		preparedMediaId,
		window: {
			endTimestampMs: input.windowEndTimestampMs,
			startTimestampMs: input.windowStartTimestampMs,
		},
	});
	const digest = await crypto.subtle.digest(
		'SHA-256',
		new TextEncoder().encode(`${payload}\n`),
	);
	return [...new Uint8Array(digest)]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
};
