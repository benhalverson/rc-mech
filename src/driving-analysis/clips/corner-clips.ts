import type { AcceptedCornerEvidenceIdentity } from '../evidence/accepted-corner-evidence';
import { subjectObservationSegmentSchema } from '../tracking/contracts';
import { pythonCanonical } from '../tracking/python-canonical';
import {
	ClipAuthorityError,
	CornerClipAuthority,
} from './corner-clip-authority';
import {
	type ClipArtifact,
	clipSha256,
	clipSpecificationCanonical,
	clipSpecificationSchema,
	MAX_CLIP_BYTES,
} from './corner-clip-contracts';
import { type ClipRenderCommand, readClipBytes } from './corner-clip-renderer';

type ClipInput = Awaited<ReturnType<CornerClipAuthority['inputs']>>[number];
type Segment = ReturnType<typeof subjectObservationSegmentSchema.parse>;
const sourcePoint = (x: number, y: number) => ({ x, y });

export const buildClipSpecification = (input: ClipInput, segment: Segment) => {
	const { pass, corner, source } = input;
	const before = segment.observations.find(
		(value) => value.frameIndex === pass.entryBeforeFrameIndex,
	);
	const after = segment.observations.find(
		(value) => value.frameIndex === pass.entryAfterFrameIndex,
	);
	if (
		!before ||
		!after ||
		pass.entryTimestampMs === null ||
		pass.exitTimestampMs === null ||
		pass.eligibility !== 'eligible'
	)
		throw new Error('CLIP_EVIDENCE_INVALID');
	const fraction =
		(pass.entryTimestampMs - before.timestampMs) /
		(after.timestampMs - before.timestampMs);
	return clipSpecificationSchema.parse({
		sourceChecksumSha256: source.sourceChecksum,
		runId: source.runId,
		trackMapVersion: source.approvedTrackMapVersionId,
		cornerId: corner.id,
		cornerView: {
			...sourcePoint(corner.viewX, corner.viewY),
			width: corner.viewWidth,
			height: corner.viewHeight,
		},
		entryTimestampMs: Math.floor(pass.entryTimestampMs),
		exitTimestampMs: Math.max(
			Math.floor(pass.entryTimestampMs) + 1,
			Math.ceil(pass.exitTimestampMs),
		),
		padding: { beforeMs: 500, afterMs: 500 },
		overlay: {
			subjectCenter: sourcePoint(
				before.center.x + fraction * (after.center.x - before.center.x),
				before.center.y + fraction * (after.center.y - before.center.y),
			),
			entryGate: {
				entry: sourcePoint(corner.entryStartX, corner.entryStartY),
				exit: sourcePoint(corner.entryEndX, corner.entryEndY),
				direction:
					corner.entryDirection === 'forward' ? 'positive' : 'negative',
			},
			exitGate: {
				entry: sourcePoint(corner.exitStartX, corner.exitStartY),
				exit: sourcePoint(corner.exitEndX, corner.exitEndY),
				direction: corner.exitDirection === 'forward' ? 'positive' : 'negative',
			},
		},
		maxOutputBytes: MAX_CLIP_BYTES,
		pipelineVersion: 'corner-render.v1',
	});
};

export const renderAcceptedCornerClips = async (
	identity: AcceptedCornerEvidenceIdentity,
	authority: CornerClipAuthority,
	bucket: R2Bucket,
	render: (command: ClipRenderCommand) => Promise<ClipArtifact>,
): Promise<void> => {
	const inputs = await authority.inputs(identity);
	const first = inputs[0];
	if (!first) return;
	const object = await bucket.get(first.batch.observationObjectKey);
	if (!object) throw new Error('CLIP_EVIDENCE_UNAVAILABLE');
	const compressed = await readClipBytes(object.body, 16 * 1024 * 1024);
	if ((await clipSha256(compressed)) !== first.batch.observationChecksumSha256)
		throw new Error('CLIP_EVIDENCE_INVALID');
	const bytes = await readClipBytes(
		new Blob([compressed])
			.stream()
			.pipeThrough(new DecompressionStream('gzip')),
		16 * 1024 * 1024,
	);
	if ((await clipSha256(bytes)) !== first.batch.observationContractDigest)
		throw new Error('CLIP_EVIDENCE_INVALID');
	const segment = subjectObservationSegmentSchema.parse(
		JSON.parse(
			new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes),
		),
	);
	if (segment.caseId !== identity.runId)
		throw new Error('CLIP_EVIDENCE_INVALID');
	for (const input of inputs) {
		const specification = buildClipSpecification(input, segment);
		const inputDigest = await clipSha256(
			new TextEncoder().encode(
				pythonCanonical({
					batchArtifactId: input.batch.artifactId,
					measurementDigest: input.batch.measurementDigest,
					ordinal: input.pass.ordinal,
					specification: clipSpecificationCanonical(specification),
				}),
			),
		);
		const clip = await authority.plan(
			identity,
			input.pass,
			specification,
			inputDigest,
			{
				objectKey: input.source.sourceObjectKey,
				byteCount: input.source.sourceByteCount,
			},
		);
		if (await authority.publication(clip.id)) continue;
		const objectKey = `corner-clips/${clip.runId}/${clip.inputDigest}.mp4`;
		const artifact = await render({
			sourceObjectKey: clip.sourceObjectKey,
			outputObjectKey: objectKey,
			request: {
				contractVersion: 'corner-render.v1',
				correlationId: crypto.randomUUID(),
				caseId: clip.runId,
				renderId: clip.id,
				input: {
					stagedMediaId: crypto.randomUUID(),
					expectedByteCount: clip.sourceByteCount,
				},
				specification,
			},
		});
		try {
			await authority.publish(clip, artifact, objectKey);
		} catch (error) {
			if (error instanceof ClipAuthorityError && error.code === 'DELETED')
				await bucket.delete(objectKey);
			throw error;
		}
	}
};

export const cornerClipRenderer =
	(environment: {
		DB: D1Database;
		ANALYSIS_MEDIA: R2Bucket;
		RACE_VIDEO_MEDIA_CONTAINER?: {
			getByName(name: string): {
				renderCornerClip?(command: ClipRenderCommand): Promise<ClipArtifact>;
			};
		};
	}) =>
	(identity: AcceptedCornerEvidenceIdentity) =>
		renderAcceptedCornerClips(
			identity,
			new CornerClipAuthority(environment.DB),
			environment.ANALYSIS_MEDIA,
			(command) => {
				const container = environment.RACE_VIDEO_MEDIA_CONTAINER?.getByName(
					`corner-render-${command.request.renderId}`,
				);
				if (!container?.renderCornerClip)
					throw new Error('CLIP_RENDER_UNAVAILABLE');
				return container.renderCornerClip(command);
			},
		);
