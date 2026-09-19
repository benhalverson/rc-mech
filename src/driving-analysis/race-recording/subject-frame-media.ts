import { readClipBytes } from '../clips/corner-clip-renderer';
import {
	MAX_SUBJECT_FRAME_BYTES,
	type SourceFrameCommand,
	sourceFrameCommandSchema,
	sourceFrameRequestSchema,
	sourceFrameResponseSchema,
} from './subject-frame-contracts';

export type SubjectFrameRuntime = Readonly<{
	bucket: R2Bucket;
	start(): Promise<void>;
	stage(path: string, body: ReadableStream): Promise<number>;
	checksum(path: string): Promise<string>;
	select(request: Request): Promise<Response>;
	cleanup(path: string): Promise<void>;
}>;

export const selectSubjectFrame = async (
	commandValue: SourceFrameCommand,
	runtime: SubjectFrameRuntime,
) => {
	const command = sourceFrameCommandSchema.parse(commandValue);
	await runtime.start();
	const source = await runtime.bucket.get(command.source.objectKey);
	if (!source || source.size !== command.source.byteCount)
		throw new Error('SUBJECT_FRAME_SOURCE_UNAVAILABLE');
	const stagedMediaId = crypto.randomUUID();
	const path = `/var/lib/rc-mech/staged/${stagedMediaId}.media`;
	try {
		if (
			(await runtime.stage(path, source.body)) !== 0 ||
			(await runtime.checksum(path)) !== command.source.checksumSha256
		)
			throw new Error('SUBJECT_FRAME_SOURCE_INVALID');
		const request = sourceFrameRequestSchema.parse({
			contractVersion: 'source-frame.v1',
			input: { stagedMediaId, expectedByteCount: command.source.byteCount },
			sourceChecksumSha256: command.source.checksumSha256,
			selection: command.selection,
			includeImage: command.includeImage,
		});
		const response = await runtime.select(
			new Request('http://driving-analysis-media/v1/frames/select', {
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
			throw new Error('SUBJECT_FRAME_UNAVAILABLE');
		const result = sourceFrameResponseSchema.parse(
			JSON.parse(
				new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(
					await readClipBytes(response.body, MAX_SUBJECT_FRAME_BYTES * 2),
				),
			),
		);
		if (
			result.sourceChecksumSha256 !== command.source.checksumSha256 ||
			(command.selection.kind === 'frame' &&
				result.frameIndex !== command.selection.frameIndex) ||
			(command.selection.kind === 'timestamp' &&
				result.timestampMs < command.selection.timestampMs) ||
			command.includeImage !== (result.imageBase64 !== null)
		)
			throw new Error('SUBJECT_FRAME_INVALID');
		return result;
	} finally {
		await runtime.cleanup(path);
	}
};
