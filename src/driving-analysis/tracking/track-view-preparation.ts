import {
	type AcceptedPreparedTrackView,
	PreparedTrackViewAuthority,
} from './prepared-track-view-authority';
import {
	type PreparedTrackViewStore,
	type PrivatePreparedTrackViewObject,
} from './r2-prepared-track-view-store';
import {
	FRAME_MANIFEST_CONTENT_TYPE,
	PREPARED_MEDIA_CONTENT_TYPE,
	type PreparedTrackViewObject,
	type PrepareStageRequest,
	prepareStageRequestSchema,
	prepareStageResponseSchema,
} from './track-view-contracts';

const RETENTION_MS = 24 * 60 * 60 * 1_000;

export type TrackViewMediaPreparationCommand = {
	request: PrepareStageRequest;
	source: {
		objectKey: string;
		byteCount: number;
		checksumSha256: string;
	};
	output: {
		mediaObjectKey: string;
		frameManifestObjectKey: string;
	};
};

export interface TrackViewMediaPreparationPort {
	prepare(command: TrackViewMediaPreparationCommand): Promise<unknown>;
}

export type PreparedTrackViewResult = {
	runId: string;
	prepared: AcceptedPreparedTrackView['descriptor'];
};

export type TrackViewPreparationErrorCode =
	| 'PREPARATION_REJECTED'
	| 'INVALID_RESPONSE'
	| 'ARTIFACT_MISMATCH'
	| 'CACHE_LOST'
	| 'CLEANUP_FAILED';

export class TrackViewPreparationError extends Error {
	constructor(
		readonly code: TrackViewPreparationErrorCode,
		message: string,
	) {
		super(message);
		this.name = 'TrackViewPreparationError';
	}
}

type TrackViewPreparationDependencies = {
	authority: PreparedTrackViewAuthority;
	media: TrackViewMediaPreparationPort;
	store: PreparedTrackViewStore;
	now?: () => Date;
	id?: () => string;
};

const storedObjectMatches = (
	stored: PrivatePreparedTrackViewObject | null,
	expected: PreparedTrackViewObject,
): boolean =>
	stored !== null &&
	stored.key === expected.objectKey &&
	stored.byteCount === expected.byteCount &&
	stored.checksumSha256 === expected.checksumSha256 &&
	stored.contentType === expected.contentType &&
	stored.contentEncoding === expected.contentEncoding;

const publicResult = (
	runId: string,
	accepted: AcceptedPreparedTrackView,
): PreparedTrackViewResult => ({ runId, prepared: accepted.descriptor });

export class TrackViewPreparation {
	private readonly authority;
	private readonly media;
	private readonly store;
	private readonly now;
	private readonly id;

	constructor(dependencies: TrackViewPreparationDependencies) {
		this.authority = dependencies.authority;
		this.media = dependencies.media;
		this.store = dependencies.store;
		this.now = dependencies.now ?? (() => new Date());
		this.id = dependencies.id ?? (() => crypto.randomUUID());
	}

	async prepare(
		ownerId: string,
		runId: string,
	): Promise<PreparedTrackViewResult> {
		const context = await this.authority.preparationContext(ownerId, runId);
		if (context.accepted) {
			await this.verifyAccepted(context.accepted, 'CACHE_LOST');
			return publicResult(runId, context.accepted);
		}

		const preparedMediaId = this.id();
		const correlationId = this.id();
		const prefix = `prepared/${preparedMediaId}`;
		const mediaObjectKey = `${prefix}/track-view.mp4`;
		const frameManifestObjectKey = `${prefix}/frame-manifest.json.gz`;
		const candidateKeys = [mediaObjectKey, frameManifestObjectKey] as const;
		const request = prepareStageRequestSchema.parse({
			contractVersion: 'subject-tracking.v1',
			correlationId,
			caseId: runId,
			preparedMediaId,
			input: {
				stagedMediaId: context.input.raceVideoId,
				expectedByteCount: context.input.sourceByteCount,
			},
			window: {
				startTimestampMs: context.input.windowStartTimestampMs,
				endTimestampMs: context.input.windowEndTimestampMs,
			},
			pipelineVersion: 'subject-tracking.v1',
		});

		let rawResponse: unknown;
		try {
			rawResponse = await this.media.prepare({
				request,
				source: {
					objectKey: context.input.sourceObjectKey,
					byteCount: context.input.sourceByteCount,
					checksumSha256: context.input.sourceChecksum,
				},
				output: { mediaObjectKey, frameManifestObjectKey },
			});
		} catch {
			await this.cleanup(candidateKeys);
			throw new TrackViewPreparationError(
				'PREPARATION_REJECTED',
				'Track-view preparation failed safely',
			);
		}

		const parsed = prepareStageResponseSchema.safeParse(rawResponse);
		if (!parsed.success) {
			await this.cleanup(candidateKeys);
			throw new TrackViewPreparationError(
				'INVALID_RESPONSE',
				'Media preparation returned an invalid response',
			);
		}
		if (parsed.data.outcome === 'rejected') {
			await this.cleanup(candidateKeys);
			throw new TrackViewPreparationError(
				'PREPARATION_REJECTED',
				parsed.data.error.message,
			);
		}
		const descriptor = parsed.data.prepared;
		if (
			parsed.data.correlationId !== correlationId ||
			parsed.data.caseId !== runId ||
			descriptor.preparedMediaId !== preparedMediaId ||
			descriptor.caseId !== runId ||
			descriptor.sourceByteCount !== context.input.sourceByteCount ||
			descriptor.sourceChecksumSha256 !== context.input.sourceChecksum ||
			descriptor.window.startTimestampMs !==
				context.input.windowStartTimestampMs ||
			descriptor.window.endTimestampMs !== context.input.windowEndTimestampMs ||
			descriptor.preparationInputDigest !== context.input.inputDigest
		) {
			await this.cleanup(candidateKeys);
			throw new TrackViewPreparationError(
				'ARTIFACT_MISMATCH',
				'Prepared descriptor does not match immutable run input',
			);
		}

		const objects = [
			{
				role: 'prepared-media',
				objectKey: mediaObjectKey,
				byteCount: descriptor.byteCount,
				checksumSha256: descriptor.checksumSha256,
				contentType: PREPARED_MEDIA_CONTENT_TYPE,
				contentEncoding: null,
			},
			{
				role: 'frame-manifest',
				objectKey: frameManifestObjectKey,
				byteCount: descriptor.frameManifestByteCount,
				checksumSha256: descriptor.frameManifestChecksumSha256,
				contentType: FRAME_MANIFEST_CONTENT_TYPE,
				contentEncoding: 'gzip',
			},
		] as const satisfies readonly PreparedTrackViewObject[];
		if (!(await this.objectsMatch(objects))) {
			await this.cleanup(candidateKeys);
			throw new TrackViewPreparationError(
				'ARTIFACT_MISMATCH',
				'Prepared private objects do not match their descriptor',
			);
		}

		const now = this.now();
		try {
			const accepted = await this.authority.acceptPreparedTrackView({
				ownerId,
				runId,
				expectedRunVersion: context.run.version,
				expectedInputDigest: context.input.inputDigest,
				descriptor,
				objects: [objects[0], objects[1]],
				deleteAfter: new Date(now.getTime() + RETENTION_MS).toISOString(),
				createdAt: now.toISOString(),
			});
			return publicResult(runId, accepted);
		} catch (error) {
			let accepted: boolean;
			try {
				accepted = await this.authority.isAcceptedCandidate(
					ownerId,
					runId,
					preparedMediaId,
				);
			} catch {
				throw error;
			}
			if (!accepted) await this.cleanup(candidateKeys);
			throw error;
		}
	}

	async cleanupDue(now = this.now()): Promise<number> {
		const candidates = await this.authority.cleanupCandidates(
			now.toISOString(),
			new Date(now.getTime() - RETENTION_MS).toISOString(),
		);
		for (const candidate of candidates) {
			await this.store.delete(
				candidate.objects.map((object) => object.objectKey),
			);
			await this.authority.markDeleted({
				ownerId: candidate.ownerId,
				runId: candidate.runId,
				preparedMediaId: candidate.preparedMediaId,
				expectedVersion: candidate.version,
				deletedAt: now.toISOString(),
			});
		}
		return candidates.length;
	}

	private async verifyAccepted(
		accepted: AcceptedPreparedTrackView,
		code: TrackViewPreparationErrorCode,
	): Promise<void> {
		const expected = accepted.objects.map((object) => ({
			role: object.role,
			objectKey: object.objectKey,
			byteCount: object.byteCount,
			checksumSha256: object.checksumSha256,
			contentType: object.contentType as PreparedTrackViewObject['contentType'],
			contentEncoding:
				object.contentEncoding as PreparedTrackViewObject['contentEncoding'],
		}));
		if (!(await this.objectsMatch(expected)))
			throw new TrackViewPreparationError(
				code,
				'Accepted prepared Track-view objects are unavailable or changed',
			);
	}

	private async objectsMatch(
		objects: readonly PreparedTrackViewObject[],
	): Promise<boolean> {
		const stored = await Promise.all(
			objects.map((object) => this.store.head(object.objectKey)),
		);
		return stored.every((object, index) => {
			const expected = objects[index];
			return expected !== undefined && storedObjectMatches(object, expected);
		});
	}

	private async cleanup(keys: readonly string[]): Promise<void> {
		try {
			await this.store.delete(keys);
		} catch {
			throw new TrackViewPreparationError(
				'CLEANUP_FAILED',
				'Candidate Track-view cleanup failed safely',
			);
		}
	}
}
