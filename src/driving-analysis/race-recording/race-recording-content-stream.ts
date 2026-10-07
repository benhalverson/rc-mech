import type { RaceRecordingContent } from './race-recording-authority';

/** Limit each private storage read while retaining the caller's complete HTTP range. */
export const RACE_RECORDING_READ_WINDOW = 8 * 1024 * 1024;

type ContentRange = Readonly<{ offset: number; length: number }>;

/** Pull one storage window at a time and cancel its reader when playback stops. */
export const raceRecordingContentStream = (
	first: RaceRecordingContent,
	range: ContentRange,
	read: (range: ContentRange) => Promise<RaceRecordingContent>,
): ReadableStream<Uint8Array> => {
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined =
		first.body.getReader();
	let offset = range.offset;
	let remaining = range.length;
	let windowRemaining = Math.min(remaining, RACE_RECORDING_READ_WINDOW);
	let cancelled = false;
	return new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					while (!cancelled) {
						if (!reader) {
							if (remaining === 0) {
								controller.close();
								return;
							}
							windowRemaining = Math.min(remaining, RACE_RECORDING_READ_WINDOW);
							const content = await read({ offset, length: windowRemaining });
							if (cancelled || content.etag !== first.etag) {
								await content.body.cancel();
								if (cancelled) return;
								throw new Error('Race recording changed during playback');
							}
							reader = content.body.getReader();
						}
						const result = await reader.read();
						if (cancelled) return;
						if (result.done) {
							reader.releaseLock();
							reader = undefined;
							if (windowRemaining !== 0)
								throw new Error('Race recording storage read was truncated');
							continue;
						}
						if (result.value.byteLength > windowRemaining)
							throw new Error('Race recording storage read exceeded its range');
						windowRemaining -= result.value.byteLength;
						remaining -= result.value.byteLength;
						offset += result.value.byteLength;
						controller.enqueue(result.value);
						return;
					}
				} catch (error) {
					await reader?.cancel(error).catch(() => undefined);
					if (!cancelled) controller.error(error);
				}
			},
			async cancel(reason) {
				cancelled = true;
				await reader?.cancel(reason);
			},
		},
		{ highWaterMark: 0 },
	);
};
