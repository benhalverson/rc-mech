import type { PreparedMediaArtifact } from './contracts';
import type { TrackingArtifactStore } from './r2-tracking-artifact-store';
import { preparedFrameManifestSchema } from './track-view-contracts';

const MAX_COMPRESSED_BYTES = 16 * 1024 * 1024;
const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;

export const readReidentificationFrames = async (
	store: Pick<TrackingArtifactStore, 'read'>,
	objectKey: string,
	prepared: PreparedMediaArtifact,
) => {
	if (prepared.frameManifestByteCount > MAX_COMPRESSED_BYTES)
		throw new Error('Prepared frame manifest exceeds the read limit');
	const object = await store.read(objectKey, prepared.frameManifestByteCount);
	if (!object || object.byteCount !== prepared.frameManifestByteCount)
		throw new Error('Prepared frame manifest is unavailable');
	const checksum = Array.from(
		new Uint8Array(await crypto.subtle.digest('SHA-256', object.bytes)),
		(value) => value.toString(16).padStart(2, '0'),
	).join('');
	if (checksum !== prepared.frameManifestChecksumSha256)
		throw new Error('Prepared frame manifest checksum differs');
	const reader = new Blob([object.bytes])
		.stream()
		.pipeThrough(new DecompressionStream('gzip'))
		.getReader();
	const output = new Uint8Array(MAX_MANIFEST_BYTES);
	let length = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (length + value.byteLength > output.byteLength) {
			await reader.cancel();
			throw new Error('Prepared frame manifest exceeds the decoded limit');
		}
		output.set(value, length);
		length += value.byteLength;
	}
	const manifest = preparedFrameManifestSchema.parse(
		JSON.parse(new TextDecoder().decode(output.subarray(0, length))),
	);
	if (
		manifest.preparedMediaId !== prepared.preparedMediaId ||
		manifest.frames.length !== prepared.decodedFrameCount
	)
		throw new Error('Prepared frame manifest does not match its authority');
	return manifest.frames.map(({ frameIndex, timestampMs }) => ({
		frameIndex,
		timestampMs,
	}));
};
