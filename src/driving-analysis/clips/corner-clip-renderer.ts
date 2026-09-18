import { parseCornerClipObjectKey } from './clip-object-key';
import {
	type ClipArtifact,
	type ClipRequest,
	clipRenderDigest,
	clipRequestSchema,
	clipResponseSchema,
	clipSha256,
} from './corner-clip-contracts';

export type ClipRenderCommand = Readonly<{
	request: ClipRequest;
	sourceObjectKey: string;
	outputObjectKey: string;
}>;
export type ClipRenderRuntime = Readonly<{
	bucket: R2Bucket;
	start(): Promise<void>;
	stage(path: string, body: ReadableStream): Promise<number>;
	checksum(path: string): Promise<string>;
	render(request: Request): Promise<Response>;
	stream(
		path: string,
	): Promise<{ body: ReadableStream; waitForExit(): Promise<number> }>;
	cleanup(path: string): Promise<void>;
}>;

export const readClipBytes = async (
	body: ReadableStream,
	maximum: number,
): Promise<Uint8Array> => {
	const reader = body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const value = await reader.read();
			if (value.done) break;
			length += value.value.byteLength;
			if (length > maximum) {
				await reader.cancel();
				throw new Error('CLIP_OUTPUT_INVALID');
			}
			chunks.push(value.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
};

/** The container receives media bytes and a specification, never R2 capabilities. */
export const renderCornerClip = async (
	command: ClipRenderCommand,
	runtime: ClipRenderRuntime,
): Promise<ClipArtifact> => {
	const request = clipRequestSchema.parse(command.request);
	const outputIdentity = parseCornerClipObjectKey(command.outputObjectKey);
	if (
		!/^race-recordings\/[0-9a-f-]{36}\/[0-9a-f-]{36}\/[0-9a-f-]{36}$/.test(
			command.sourceObjectKey,
		) ||
		outputIdentity.runId !== request.specification.runId
	)
		throw new Error('CLIP_INPUT_INVALID');
	await runtime.start();
	const source = await runtime.bucket.get(command.sourceObjectKey);
	if (!source || source.size !== request.input.expectedByteCount)
		throw new Error('CLIP_SOURCE_UNAVAILABLE');
	const path = `/var/lib/rc-mech/staged/${request.input.stagedMediaId}.media`;
	try {
		if (
			(await runtime.stage(path, source.body)) !== 0 ||
			(await runtime.checksum(path)) !==
				request.specification.sourceChecksumSha256
		)
			throw new Error('CLIP_SOURCE_INVALID');
		const response = await runtime.render(
			new Request('http://driving-analysis-media/v1/stages/render', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify(request),
			}),
		);
		if (
			response.status !== 200 ||
			!response.body ||
			response.headers.get('content-type')?.split(';')[0] !== 'application/json'
		)
			throw new Error('CLIP_RENDER_FAILED');
		const result = clipResponseSchema.parse(
			JSON.parse(
				new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
					await readClipBytes(response.body, 64 * 1024),
				),
			),
		);
		if (result.outcome === 'rejected') throw new Error('CLIP_RENDER_FAILED');
		const artifact = result.artifact;
		if (
			result.correlationId !== request.correlationId ||
			result.caseId !== request.caseId ||
			artifact.renderId !== request.renderId ||
			artifact.caseId !== request.caseId ||
			artifact.sourceChecksumSha256 !==
				request.specification.sourceChecksumSha256 ||
			artifact.byteCount > request.specification.maxOutputBytes ||
			artifact.renderInputDigest !==
				(await clipRenderDigest(request, artifact.ffmpegVersion))
		)
			throw new Error('CLIP_OUTPUT_INVALID');
		const stream = await runtime.stream(
			`/var/lib/rc-mech/artifacts/${request.renderId}.corner/${request.renderId}.corner.mp4`,
		);
		const bytes = await readClipBytes(
			stream.body,
			request.specification.maxOutputBytes,
		);
		if (
			(await stream.waitForExit()) !== 0 ||
			bytes.byteLength !== artifact.byteCount ||
			(await clipSha256(bytes)) !== artifact.checksumSha256
		)
			throw new Error('CLIP_OUTPUT_INVALID');
		const stored = await runtime.bucket.put(command.outputObjectKey, bytes, {
			onlyIf: { etagDoesNotMatch: '*' },
			httpMetadata: {
				contentType: 'video/mp4',
				cacheControl: 'private, no-store',
			},
			customMetadata: {
				sha256: artifact.checksumSha256,
				renderInputDigest: artifact.renderInputDigest,
			},
		});
		if (!stored) {
			const existing = await runtime.bucket.head(command.outputObjectKey);
			if (
				!existing ||
				existing.size !== artifact.byteCount ||
				existing.customMetadata?.sha256 !== artifact.checksumSha256 ||
				existing.customMetadata.renderInputDigest !== artifact.renderInputDigest
			)
				throw new Error('CLIP_ARTIFACT_CONFLICT');
		}
		return artifact;
	} finally {
		await runtime.cleanup(path);
	}
};
