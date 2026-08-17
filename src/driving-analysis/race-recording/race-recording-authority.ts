import {
	and,
	asc,
	eq,
	exists,
	isNull,
	lte,
	notExists,
	or,
	sql,
} from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import {
	authRateLimit,
	car,
	driveSession,
	raceVideo,
	raceVideoUploadPart,
	raceVideoValidation,
	trackingRun,
	trackingRunInput,
} from '../../schema';
import {
	type CreateRaceRecordingInput,
	MAX_ACTIVE_RACE_RECORDING_BYTES_PER_OWNER,
	MAX_ACTIVE_RACE_RECORDINGS_PER_OWNER,
	MAX_RACE_RECORDING_CREATIONS_PER_HOUR,
	MAX_RETAINED_RACE_RECORDING_BYTES_PER_OWNER,
	type PublicRaceRecording,
	RACE_RECORDING_CREATION_WINDOW_MS,
	RACE_RECORDING_PART_SIZE,
	RACE_RECORDING_UPLOAD_TTL_MS,
} from './race-recording-contracts';
import { RaceVideoValidationAuthority } from './race-video-validation-authority';
import {
	type RaceVideoValidationWorkflowPayload,
	raceVideoPlaybackContentType,
} from './race-video-validation-contracts';

type RaceVideoRecord = typeof raceVideo.$inferSelect;
type RaceVideoPartRecord = typeof raceVideoUploadPart.$inferSelect;

export type RaceRecordingAuthorityErrorCode =
	| 'CONFLICT'
	| 'EXPIRED'
	| 'INVALID_PART'
	| 'NOT_FOUND'
	| 'QUOTA_EXCEEDED'
	| 'RATE_LIMITED'
	| 'STORAGE_UNAVAILABLE';

export class RaceRecordingAuthorityError extends Error {
	readonly name = 'RaceRecordingAuthorityError';

	constructor(
		readonly code: RaceRecordingAuthorityErrorCode,
		message: string,
	) {
		super(message);
	}
}

export type CreateRaceRecordingCommand = Readonly<{
	ownerId: string;
	carId: string;
	driveSessionId: string;
	input: CreateRaceRecordingInput;
}>;

export type UploadRaceRecordingPartCommand = Readonly<{
	ownerId: string;
	recordingId: string;
	partNumber: number;
	transferRequestId: string;
	body: ReadableStream;
	byteCount: number;
}>;

export type RaceRecordingIdentity = Readonly<{
	ownerId: string;
	recordingId: string;
}>;

export type RaceRecordingAuthorityOptions = Readonly<{
	clock?: () => Date;
	id?: () => string;
	claimId?: () => string;
	startValidation?: (
		payload: RaceVideoValidationWorkflowPayload,
	) => Promise<void>;
}>;

export type RaceRecordingContentMetadata = Readonly<{
	size: number;
	contentType: PublicRaceRecording['contentType'];
	etag: string;
	uploaded: Date;
}>;

export type RaceRecordingContent = RaceRecordingContentMetadata &
	Readonly<{ body: ReadableStream }>;

const authorityError = (
	code: RaceRecordingAuthorityErrorCode,
	message: string,
) => new RaceRecordingAuthorityError(code, message);

const sameCandidate = (
	recording: RaceVideoRecord,
	input: CreateRaceRecordingInput,
): boolean =>
	recording.fileName === input.fileName &&
	recording.contentType === input.contentType &&
	recording.declaredSize === input.sizeBytes;

const errorMessage = (error: unknown): string =>
	error instanceof Error ? `${error.name}: ${error.message}` : String(error);

const isMissingMultipartUpload = (error: unknown): boolean =>
	/NoSuchUpload|multipart upload was not found|(?:^|\D)10024(?:\D|$)/i.test(
		errorMessage(error),
	);

const expectedPartSize = (
	declaredSize: number,
	partNumber: number,
): number | null => {
	const partCount = Math.ceil(declaredSize / RACE_RECORDING_PART_SIZE);
	if (partNumber < 1 || partNumber > partCount) return null;
	if (partNumber < partCount) return RACE_RECORDING_PART_SIZE;
	return declaredSize - RACE_RECORDING_PART_SIZE * (partCount - 1);
};

const PART_CLAIM_STALE_MS = 15 * 60 * 1000;

export class RaceRecordingAuthority {
	private readonly database;
	private readonly clock: () => Date;
	private readonly id: () => string;
	private readonly claimId: () => string;
	private readonly validationAuthority: RaceVideoValidationAuthority;
	private readonly startValidation: (
		payload: RaceVideoValidationWorkflowPayload,
	) => Promise<void>;

	constructor(
		binding: D1Database,
		private readonly bucket: R2Bucket,
		options: RaceRecordingAuthorityOptions = {},
	) {
		this.database = drizzle(binding);
		this.clock = options.clock ?? (() => new Date());
		this.id = options.id ?? (() => crypto.randomUUID());
		this.claimId = options.claimId ?? (() => crypto.randomUUID());
		this.validationAuthority = new RaceVideoValidationAuthority(binding);
		this.startValidation = options.startValidation ?? (async () => undefined);
	}

	async list(ownerId: string, carId: string): Promise<PublicRaceRecording[]> {
		await this.requireOwnedCar(ownerId, carId);
		await this.cleanupExpired(ownerId);
		const recordings = await this.database
			.select()
			.from(raceVideo)
			.where(and(eq(raceVideo.ownerId, ownerId), eq(raceVideo.carId, carId)))
			.orderBy(asc(raceVideo.createdAt));
		return Promise.all(recordings.map((recording) => this.public(recording)));
	}

	async get(
		ownerId: string,
		recordingId: string,
	): Promise<PublicRaceRecording> {
		return this.public(await this.requireRecording({ ownerId, recordingId }));
	}

	async create(command: CreateRaceRecordingCommand): Promise<{
		recording: PublicRaceRecording;
		created: boolean;
	}> {
		await this.requireActiveDrive(command);
		await this.cleanupExpired(command.ownerId);
		const replay = await this.database
			.select()
			.from(raceVideo)
			.where(
				and(
					eq(raceVideo.ownerId, command.ownerId),
					eq(raceVideo.requestId, command.input.requestId),
				),
			)
			.get();
		if (replay) return this.existingCandidate(replay, command);
		const existing = await this.database
			.select()
			.from(raceVideo)
			.where(eq(raceVideo.driveSessionId, command.driveSessionId))
			.get();
		if (existing) return this.existingCandidate(existing, command);
		await this.requireOwnerWithinQuota(
			command.ownerId,
			command.input.sizeBytes,
		);
		await this.consumeCreationPermit(command.ownerId);

		const recordingId = this.id();
		const objectKey = `race-recordings/${this.id()}/${this.id()}/${recordingId}`;
		let multipart: R2MultipartUpload;
		try {
			multipart = await this.bucket.createMultipartUpload(objectKey, {
				httpMetadata: { contentType: 'application/octet-stream' },
				customMetadata: {
					recordingId,
					declaredSize: String(command.input.sizeBytes),
				},
			});
		} catch {
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Private media storage is unavailable',
			);
		}
		const now = this.clock();
		const createdAt = now.toISOString();
		try {
			await this.database.insert(raceVideo).values({
				id: recordingId,
				ownerId: command.ownerId,
				carId: command.carId,
				driveSessionId: command.driveSessionId,
				requestId: command.input.requestId,
				objectKey,
				multipartUploadId: multipart.uploadId,
				fileName: command.input.fileName,
				contentType: command.input.contentType,
				declaredSize: command.input.sizeBytes,
				actualSize: null,
				partSize: RACE_RECORDING_PART_SIZE,
				status: 'uploading',
				createdAt,
				updatedAt: createdAt,
				expiresAt: new Date(
					now.getTime() + RACE_RECORDING_UPLOAD_TTL_MS,
				).toISOString(),
				completedAt: null,
			});
		} catch {
			try {
				await multipart.abort();
			} catch {
				throw authorityError(
					'STORAGE_UNAVAILABLE',
					'Conflicting private media could not be discarded',
				);
			}
			const raced = await this.database
				.select()
				.from(raceVideo)
				.where(eq(raceVideo.driveSessionId, command.driveSessionId))
				.get();
			if (raced) return this.existingCandidate(raced, command);
			await this.requireOwnerWithinQuota(
				command.ownerId,
				command.input.sizeBytes,
			);
			throw authorityError(
				'CONFLICT',
				'Race-recording upload could not be created',
			);
		}
		const created = await this.requireRecording({
			...command,
			recordingId,
		});
		return { recording: await this.public(created), created: true };
	}

	async uploadPart(
		command: UploadRaceRecordingPartCommand,
	): Promise<PublicRaceRecording> {
		const recording = await this.requireRecording(command);
		await this.requireUploading(recording);
		await this.requireOwnerWithinQuota(recording.ownerId);
		const partSize = expectedPartSize(
			recording.declaredSize,
			command.partNumber,
		);
		if (partSize === null || command.byteCount !== partSize)
			throw authorityError(
				'INVALID_PART',
				'Race-recording part does not match its exact byte range',
			);

		const transferScope = await this.database
			.select()
			.from(raceVideoUploadPart)
			.where(
				and(
					eq(raceVideoUploadPart.raceVideoId, recording.id),
					or(
						eq(
							raceVideoUploadPart.transferRequestId,
							command.transferRequestId,
						),
						eq(
							raceVideoUploadPart.claimTransferRequestId,
							command.transferRequestId,
						),
					),
				),
			)
			.get();
		if (
			transferScope &&
			(transferScope.partNumber !== command.partNumber ||
				transferScope.byteCount !== command.byteCount)
		)
			throw authorityError(
				'CONFLICT',
				'Transfer request identity was replayed with different scope',
			);
		const staleClaimCutoff = new Date(
			this.clock().getTime() - PART_CLAIM_STALE_MS,
		).toISOString();
		const isStaleClaim = (part: RaceVideoPartRecord): boolean =>
			part.status === 'uploading' &&
			part.claimedAt !== null &&
			part.claimedAt <= staleClaimCutoff;
		if (transferScope?.status === 'uploading' && !isStaleClaim(transferScope))
			throw authorityError(
				'CONFLICT',
				'This Race-recording part is already being stored',
			);

		const previous = await this.database
			.select()
			.from(raceVideoUploadPart)
			.where(
				and(
					eq(raceVideoUploadPart.raceVideoId, recording.id),
					eq(raceVideoUploadPart.partNumber, command.partNumber),
				),
			)
			.get();
		if (
			previous?.status === 'uploading' &&
			(!isStaleClaim(previous) ||
				previous.claimTransferRequestId !== command.transferRequestId)
		)
			throw authorityError(
				'CONFLICT',
				'This Race-recording part is already being stored',
			);
		const claimId = this.claimId();
		const claimedAt = this.clock().toISOString();
		let claimed: { claimId: string | null } | undefined;
		try {
			claimed = previous
				? await this.database
						.update(raceVideoUploadPart)
						.set({
							status: 'uploading',
							claimId,
							claimTransferRequestId: command.transferRequestId,
							claimedAt,
						})
						.where(
							and(
								eq(raceVideoUploadPart.raceVideoId, recording.id),
								eq(raceVideoUploadPart.partNumber, command.partNumber),
								eq(raceVideoUploadPart.status, previous.status),
								previous.status === 'uploading'
									? eq(raceVideoUploadPart.claimId, previous.claimId)
									: undefined,
								previous.status === 'uploading'
									? lte(raceVideoUploadPart.claimedAt, staleClaimCutoff)
									: undefined,
							),
						)
						.returning({ claimId: raceVideoUploadPart.claimId })
						.get()
				: await this.database
						.insert(raceVideoUploadPart)
						.values({
							raceVideoId: recording.id,
							partNumber: command.partNumber,
							transferRequestId: null,
							status: 'uploading',
							claimId,
							claimTransferRequestId: command.transferRequestId,
							etag: null,
							byteCount: command.byteCount,
							claimedAt,
							uploadedAt: null,
						})
						.onConflictDoNothing()
						.returning({ claimId: raceVideoUploadPart.claimId })
						.get();
		} catch {
			throw authorityError(
				'CONFLICT',
				'This Race-recording part is already being stored',
			);
		}
		if (claimed?.claimId !== claimId)
			throw authorityError(
				'CONFLICT',
				'This Race-recording part is already being stored',
			);
		const uploadingParent = await this.database
			.select({ id: raceVideo.id })
			.from(raceVideo)
			.where(
				and(
					eq(raceVideo.id, recording.id),
					eq(raceVideo.ownerId, command.ownerId),
					eq(raceVideo.status, 'uploading'),
				),
			)
			.get();
		if (!uploadingParent) {
			await this.releasePartClaim(
				recording.id,
				command.partNumber,
				claimId,
				previous,
			);
			throw authorityError(
				'CONFLICT',
				'Race recording changed while the part was being claimed',
			);
		}

		let uploaded: R2UploadedPart;
		try {
			uploaded = await this.bucket
				.resumeMultipartUpload(recording.objectKey, recording.multipartUploadId)
				.uploadPart(command.partNumber, command.body);
		} catch {
			await this.releasePartClaim(
				recording.id,
				command.partNumber,
				claimId,
				previous,
			);
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Race-recording part could not be stored',
			);
		}
		const uploadedAt = this.clock().toISOString();
		try {
			const finalized = await this.database
				.update(raceVideoUploadPart)
				.set({
					transferRequestId: command.transferRequestId,
					status: 'uploaded',
					claimId: null,
					claimTransferRequestId: null,
					etag: uploaded.etag,
					byteCount: command.byteCount,
					claimedAt: null,
					uploadedAt,
				})
				.where(
					and(
						eq(raceVideoUploadPart.raceVideoId, recording.id),
						eq(raceVideoUploadPart.partNumber, command.partNumber),
						eq(raceVideoUploadPart.status, 'uploading'),
						eq(raceVideoUploadPart.claimId, claimId),
					),
				)
				.returning({ partNumber: raceVideoUploadPart.partNumber })
				.get();
			if (!finalized)
				throw authorityError(
					'CONFLICT',
					'Race-recording part claim is no longer current',
				);
			const touched = await this.database
				.update(raceVideo)
				.set({ updatedAt: uploadedAt })
				.where(
					and(
						eq(raceVideo.id, recording.id),
						eq(raceVideo.ownerId, command.ownerId),
						eq(raceVideo.status, 'uploading'),
					),
				)
				.returning()
				.get();
			if (!touched)
				throw authorityError(
					'CONFLICT',
					'Race recording changed while part progress was saved',
				);
		} catch {
			await this.markPartRecoverable(recording.id, command.partNumber, claimId);
			throw authorityError(
				'CONFLICT',
				'Race-recording part progress could not be persisted',
			);
		}
		return this.public(
			await this.requireRecording(command),
			await this.parts(recording.id),
		);
	}

	async complete(
		identity: RaceRecordingIdentity,
	): Promise<PublicRaceRecording> {
		let recording = await this.requireRecording(identity);
		if (recording.status === 'validating')
			return this.ensureValidation(recording);
		let ownsCompletion = false;
		if (recording.status === 'uploading') {
			const claimed = await this.database
				.update(raceVideo)
				.set({ status: 'completing', updatedAt: this.clock().toISOString() })
				.where(
					and(
						eq(raceVideo.id, recording.id),
						eq(raceVideo.ownerId, identity.ownerId),
						eq(raceVideo.status, 'uploading'),
						notExists(
							this.database
								.select({ partNumber: raceVideoUploadPart.partNumber })
								.from(raceVideoUploadPart)
								.where(
									and(
										eq(raceVideoUploadPart.raceVideoId, raceVideo.id),
										eq(raceVideoUploadPart.status, 'uploading'),
									),
								),
						),
					),
				)
				.returning()
				.get();
			if (claimed) {
				recording = claimed;
				ownsCompletion = true;
			} else recording = await this.requireRecording(identity);
		}
		if (recording.status === 'validating')
			return this.ensureValidation(recording);
		if (recording.status !== 'completing')
			throw authorityError('CONFLICT', 'Race recording cannot be completed');
		return this.finishCompletion(recording, identity.ownerId, ownsCompletion);
	}

	private async finishCompletion(
		recording: RaceVideoRecord,
		ownerId: string,
		mayReset: boolean,
	): Promise<PublicRaceRecording> {
		const parts = await this.parts(recording.id);
		const partCount = Math.ceil(
			recording.declaredSize / RACE_RECORDING_PART_SIZE,
		);
		if (
			parts.length !== partCount ||
			parts.some(
				(part, index) =>
					part.partNumber !== index + 1 ||
					part.byteCount !==
						expectedPartSize(recording.declaredSize, part.partNumber),
			)
		) {
			if (mayReset)
				await this.database
					.update(raceVideo)
					.set({ status: 'uploading', updatedAt: this.clock().toISOString() })
					.where(
						and(
							eq(raceVideo.id, recording.id),
							eq(raceVideo.status, 'completing'),
						),
					);
			throw authorityError(
				'CONFLICT',
				'Every Race-recording part must be present before completion',
			);
		}
		const orderedParts = parts.map(({ partNumber, etag }) => ({
			partNumber,
			etag: etag as string,
		}));

		let completed: R2Object | null = null;
		try {
			completed = await this.bucket
				.resumeMultipartUpload(recording.objectKey, recording.multipartUploadId)
				.complete(orderedParts);
		} catch {
			completed = null;
		}
		if (!this.isCompletedObject(recording, completed)) {
			try {
				completed = await this.bucket.head(recording.objectKey);
			} catch {
				completed = null;
			}
		}
		if (!this.isCompletedObject(recording, completed)) {
			if (mayReset)
				await this.database
					.update(raceVideo)
					.set({ status: 'uploading', updatedAt: this.clock().toISOString() })
					.where(
						and(
							eq(raceVideo.id, recording.id),
							eq(raceVideo.status, 'completing'),
						),
					);
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Completed private media could not be verified',
			);
		}

		return this.persistCompleted(recording, completed, ownerId, parts);
	}

	private isCompletedObject(
		recording: RaceVideoRecord,
		completed: R2Object | null,
	): completed is R2Object {
		return (
			completed !== null &&
			completed.size === recording.declaredSize &&
			completed.customMetadata?.['recordingId'] === recording.id &&
			completed.customMetadata?.['declaredSize'] ===
				String(recording.declaredSize)
		);
	}

	private async persistCompleted(
		recording: RaceVideoRecord,
		completed: R2Object,
		ownerId: string,
		knownParts?: RaceVideoPartRecord[],
	): Promise<PublicRaceRecording> {
		const completedAt = this.clock().toISOString();
		const [finalizedRows] = await this.database.batch([
			this.database
				.update(raceVideo)
				.set({
					status: 'validating',
					actualSize: completed.size,
					completedAt,
					updatedAt: completedAt,
				})
				.where(
					and(
						eq(raceVideo.id, recording.id),
						eq(raceVideo.ownerId, ownerId),
						eq(raceVideo.status, 'completing'),
					),
				)
				.returning(),
			this.database
				.insert(raceVideoValidation)
				.values({
					raceVideoId: recording.id,
					validationId: recording.id,
					status: 'pending',
					stateVersion: 1,
					startedAt: completedAt,
					updatedAt: completedAt,
					completedAt: null,
				})
				.onConflictDoNothing({ target: raceVideoValidation.raceVideoId }),
		]);
		const finalized = finalizedRows?.[0];
		if (finalized) return this.ensureValidation(finalized, knownParts);
		const current = await this.requireRecording({
			ownerId,
			recordingId: recording.id,
		});
		if (current.status === 'validating')
			return this.ensureValidation(current, knownParts);
		throw authorityError(
			'CONFLICT',
			'Race recording changed while completion was being persisted',
		);
	}

	async remove(identity: RaceRecordingIdentity): Promise<void> {
		const recording = await this.findRecording(identity);
		if (!recording) return;
		if (await this.validationAuthority.hasActiveAnalysis(recording.id))
			throw authorityError(
				'CONFLICT',
				'Race recording cannot be deleted during an active analysis',
			);
		if (recording.status === 'completing')
			throw authorityError(
				'CONFLICT',
				'Race-recording completion is already in progress',
			);
		if (!(await this.discard(recording)))
			throw authorityError(
				'CONFLICT',
				'Race recording changed while deletion was starting',
			);
	}

	async contentMetadata(
		identity: RaceRecordingIdentity,
	): Promise<RaceRecordingContentMetadata> {
		const { recording, contentType } =
			await this.requireReadyRecording(identity);
		let object: R2Object | null;
		try {
			object = await this.bucket.head(recording.objectKey);
		} catch {
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Private Race recording playback is unavailable',
			);
		}
		if (!this.isCompletedObject(recording, object))
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Private Race recording playback is unavailable',
			);
		return {
			size: object.size,
			contentType,
			etag: object.httpEtag,
			uploaded: object.uploaded,
		};
	}

	async content(
		identity: RaceRecordingIdentity,
		range?: Readonly<{ offset: number; length: number }>,
	): Promise<RaceRecordingContent> {
		const { recording, contentType } =
			await this.requireReadyRecording(identity);
		let object: R2ObjectBody | null;
		try {
			object = await this.bucket.get(
				recording.objectKey,
				range ? { range } : undefined,
			);
		} catch {
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Private Race recording playback is unavailable',
			);
		}
		if (!object || !this.isCompletedObject(recording, object))
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Private Race recording playback is unavailable',
			);
		return {
			size: object.size,
			contentType,
			etag: object.httpEtag,
			uploaded: object.uploaded,
			body: object.body,
		};
	}

	async cleanupExpired(ownerId?: string, limit = 25): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError('Cleanup limit must be between 1 and 100');
		const now = this.clock().toISOString();
		const expired = await this.database
			.select()
			.from(raceVideo)
			.where(
				and(
					eq(raceVideo.status, 'uploading'),
					lte(raceVideo.expiresAt, now),
					ownerId ? eq(raceVideo.ownerId, ownerId) : undefined,
				),
			)
			.orderBy(asc(raceVideo.expiresAt))
			.limit(limit);
		let deleted = 0;
		for (const recording of expired)
			if (await this.discard(recording)) deleted += 1;
		return deleted;
	}

	async recoverStale(limit = 100): Promise<number> {
		if (!Number.isInteger(limit) || limit < 1 || limit > 100)
			throw new RangeError('Recovery limit must be between 1 and 100');
		const now = this.clock();
		const staleCutoff = new Date(
			now.getTime() - PART_CLAIM_STALE_MS,
		).toISOString();
		const candidates = await this.database
			.select()
			.from(raceVideo)
			.where(
				or(
					and(
						eq(raceVideo.status, 'uploading'),
						lte(raceVideo.expiresAt, now.toISOString()),
					),
					and(
						eq(raceVideo.status, 'completing'),
						lte(raceVideo.updatedAt, staleCutoff),
					),
					eq(raceVideo.status, 'deleting'),
					and(
						eq(raceVideo.status, 'validating'),
						or(
							notExists(
								this.database
									.select({ id: raceVideoValidation.raceVideoId })
									.from(raceVideoValidation)
									.where(eq(raceVideoValidation.raceVideoId, raceVideo.id)),
							),
							exists(
								this.database
									.select({ id: raceVideoValidation.raceVideoId })
									.from(raceVideoValidation)
									.where(
										and(
											eq(raceVideoValidation.raceVideoId, raceVideo.id),
											eq(raceVideoValidation.status, 'pending'),
										),
									),
							),
							exists(
								this.database
									.select({ id: raceVideoValidation.raceVideoId })
									.from(raceVideoValidation)
									.where(
										and(
											eq(raceVideoValidation.raceVideoId, raceVideo.id),
											eq(raceVideoValidation.status, 'invalid'),
										),
									),
							),
						),
					),
				),
			)
			.orderBy(asc(raceVideo.updatedAt))
			.limit(limit);
		let processed = 0;
		for (const recording of candidates) {
			try {
				if (recording.status === 'completing')
					await this.finishCompletion(recording, recording.ownerId, true);
				else if (recording.status === 'validating') {
					const validation = await this.validationAuthority.public(
						recording.id,
					);
					if (validation?.status === 'invalid') await this.discard(recording);
					else if (!validation || validation.status === 'validating')
						await this.ensureValidation(recording);
				} else await this.discard(recording);
			} catch {
				// Every state remains eligible for a later bounded recovery pass.
			} finally {
				processed += 1;
			}
		}
		const remaining = limit - processed;
		if (remaining < 1) return processed;
		const staleClaims = await this.database
			.select()
			.from(raceVideoUploadPart)
			.where(
				and(
					eq(raceVideoUploadPart.status, 'uploading'),
					lte(raceVideoUploadPart.claimedAt, staleCutoff),
				),
			)
			.orderBy(asc(raceVideoUploadPart.claimedAt))
			.limit(remaining);
		for (const part of staleClaims) {
			await this.markPartRecoverable(
				part.raceVideoId,
				part.partNumber,
				part.claimId as string,
			);
			processed += 1;
		}
		return processed;
	}

	private async requireOwnerWithinQuota(
		ownerId: string,
		additionalBytes = 0,
	): Promise<void> {
		const retained = await this.database
			.select({
				declaredSize: raceVideo.declaredSize,
				status: raceVideo.status,
			})
			.from(raceVideo)
			.where(eq(raceVideo.ownerId, ownerId));
		const active = retained.filter(
			(recording) =>
				recording.status === 'uploading' || recording.status === 'completing',
		);
		const activeBytes = active.reduce(
			(total, recording) => total + recording.declaredSize,
			0,
		);
		const retainedBytes = retained.reduce(
			(total, recording) => total + recording.declaredSize,
			0,
		);
		if (
			active.length + (additionalBytes > 0 ? 1 : 0) >
				MAX_ACTIVE_RACE_RECORDINGS_PER_OWNER ||
			activeBytes + additionalBytes >
				MAX_ACTIVE_RACE_RECORDING_BYTES_PER_OWNER ||
			retainedBytes + additionalBytes >
				MAX_RETAINED_RACE_RECORDING_BYTES_PER_OWNER
		)
			throw authorityError(
				'QUOTA_EXCEEDED',
				'Race-recording upload quota has been reached',
			);
	}

	private async consumeCreationPermit(ownerId: string): Promise<void> {
		const key = `race-video-upload:${ownerId}`;
		const now = this.clock().getTime();
		const expiredBefore = now - RACE_RECORDING_CREATION_WINDOW_MS;
		const updated = await this.database
			.insert(authRateLimit)
			.values({ key, windowStartedAt: now, count: 1 })
			.onConflictDoUpdate({
				target: authRateLimit.key,
				set: {
					count: sql<number>`CASE WHEN ${authRateLimit.windowStartedAt} <= ${expiredBefore} THEN 1 ELSE ${authRateLimit.count} + 1 END`,
					windowStartedAt: sql<number>`CASE WHEN ${authRateLimit.windowStartedAt} <= ${expiredBefore} THEN ${now} ELSE ${authRateLimit.windowStartedAt} END`,
				},
			})
			.returning({ count: authRateLimit.count })
			.get();
		if (!updated || updated.count > MAX_RACE_RECORDING_CREATIONS_PER_HOUR)
			throw authorityError(
				'RATE_LIMITED',
				'Too many Race-recording uploads were created recently',
			);
	}

	private async existingCandidate(
		existing: RaceVideoRecord,
		command: CreateRaceRecordingCommand,
	): Promise<{ recording: PublicRaceRecording; created: boolean }> {
		if (
			existing.ownerId !== command.ownerId ||
			existing.carId !== command.carId ||
			existing.driveSessionId !== command.driveSessionId ||
			!sameCandidate(existing, command.input)
		)
			throw authorityError(
				'CONFLICT',
				'This Drive session already has a different Race recording',
			);
		return { recording: await this.public(existing), created: false };
	}

	private async requireOwnedCar(ownerId: string, carId: string) {
		const owned = await this.database
			.select()
			.from(car)
			.where(and(eq(car.id, carId), eq(car.ownerId, ownerId)))
			.get();
		if (!owned)
			throw authorityError('NOT_FOUND', 'Car was not found for this owner');
		return owned;
	}

	private async requireActiveDrive(command: {
		ownerId: string;
		carId: string;
		driveSessionId: string;
	}): Promise<void> {
		const owned = await this.requireOwnedCar(command.ownerId, command.carId);
		if (owned.archivedAt)
			throw authorityError(
				'CONFLICT',
				'Restore this car before attaching a Race recording',
			);
		const drive = await this.database
			.select({ id: driveSession.id })
			.from(driveSession)
			.where(
				and(
					eq(driveSession.id, command.driveSessionId),
					eq(driveSession.carId, command.carId),
					isNull(driveSession.deletedAt),
				),
			)
			.get();
		if (!drive)
			throw authorityError(
				'NOT_FOUND',
				'Drive session was not found for this car',
			);
	}

	private async findRecording(
		identity: RaceRecordingIdentity,
	): Promise<RaceVideoRecord | undefined> {
		return this.database
			.select()
			.from(raceVideo)
			.where(
				and(
					eq(raceVideo.id, identity.recordingId),
					eq(raceVideo.ownerId, identity.ownerId),
				),
			)
			.get();
	}

	private async requireRecording(
		identity: RaceRecordingIdentity,
	): Promise<RaceVideoRecord> {
		const recording = await this.findRecording(identity);
		if (!recording)
			throw authorityError(
				'NOT_FOUND',
				'Race recording was not found for this owner and Drive session',
			);
		return recording;
	}

	private async requireUploading(recording: RaceVideoRecord): Promise<void> {
		if (recording.status !== 'uploading')
			throw authorityError('CONFLICT', 'Race recording is already complete');
		if (recording.expiresAt > this.clock().toISOString()) return;
		if (!(await this.discard(recording)))
			throw authorityError(
				'CONFLICT',
				'Race recording changed while expiration was being enforced',
			);
		throw authorityError('EXPIRED', 'Race-recording upload has expired');
	}

	private async parts(recordingId: string): Promise<RaceVideoPartRecord[]> {
		return this.database
			.select()
			.from(raceVideoUploadPart)
			.where(
				and(
					eq(raceVideoUploadPart.raceVideoId, recordingId),
					eq(raceVideoUploadPart.status, 'uploaded'),
				),
			)
			.orderBy(asc(raceVideoUploadPart.partNumber));
	}

	private async releasePartClaim(
		recordingId: string,
		partNumber: number,
		claimId: string,
		previous: RaceVideoPartRecord | undefined,
	): Promise<void> {
		try {
			if (previous?.status === 'uploaded') {
				await this.database
					.update(raceVideoUploadPart)
					.set({
						transferRequestId: previous.transferRequestId,
						status: 'uploaded',
						claimId: null,
						claimTransferRequestId: null,
						etag: previous.etag,
						byteCount: previous.byteCount,
						claimedAt: null,
						uploadedAt: previous.uploadedAt,
					})
					.where(
						and(
							eq(raceVideoUploadPart.raceVideoId, recordingId),
							eq(raceVideoUploadPart.partNumber, partNumber),
							eq(raceVideoUploadPart.claimId, claimId),
						),
					);
				return;
			}
			await this.database
				.delete(raceVideoUploadPart)
				.where(
					and(
						eq(raceVideoUploadPart.raceVideoId, recordingId),
						eq(raceVideoUploadPart.partNumber, partNumber),
						eq(raceVideoUploadPart.claimId, claimId),
					),
				);
		} catch {
			// The upload remains non-completable and expiration cleanup can safely
			// discard it if D1 is temporarily unavailable during claim release.
		}
	}

	private async markPartRecoverable(
		recordingId: string,
		partNumber: number,
		claimId: string,
	): Promise<void> {
		try {
			await this.database
				.update(raceVideoUploadPart)
				.set({
					transferRequestId: null,
					status: 'recoverable',
					claimId: null,
					claimTransferRequestId: null,
					etag: null,
					claimedAt: null,
					uploadedAt: null,
				})
				.where(
					and(
						eq(raceVideoUploadPart.raceVideoId, recordingId),
						eq(raceVideoUploadPart.partNumber, partNumber),
						eq(raceVideoUploadPart.claimId, claimId),
					),
				);
		} catch {
			// A still-claimed part remains excluded from completion and is removed
			// by the same bounded upload-expiration cleanup path.
		}
	}

	private async public(
		recording: RaceVideoRecord,
		knownParts?: RaceVideoPartRecord[],
	): Promise<PublicRaceRecording> {
		const parts = knownParts ?? (await this.parts(recording.id));
		const validation =
			recording.status === 'validating'
				? await this.validationAuthority.public(recording.id)
				: null;
		return {
			id: recording.id,
			carId: recording.carId,
			driveSessionId: recording.driveSessionId,
			fileName: recording.fileName,
			contentType: recording.contentType as PublicRaceRecording['contentType'],
			sizeBytes: recording.declaredSize,
			partSizeBytes: recording.partSize,
			status:
				validation?.status ??
				(recording.status === 'validating' ? 'validating' : 'uploading'),
			uploadedBytes: parts.reduce((total, part) => total + part.byteCount, 0),
			uploadedPartNumbers: parts.map(({ partNumber }) => partNumber),
			validationStateVersion: validation?.stateVersion ?? null,
			media: validation?.media ?? null,
			validationError: validation?.error ?? null,
			validatedAt: validation?.validatedAt ?? null,
			playbackUrl:
				validation?.status === 'ready'
					? `/api/v1/race-videos/${encodeURIComponent(recording.id)}/content`
					: null,
			createdAt: recording.createdAt,
			updatedAt: recording.updatedAt,
			expiresAt: recording.expiresAt,
			completedAt: recording.completedAt,
		};
	}

	private async ensureValidation(
		recording: RaceVideoRecord,
		knownParts?: RaceVideoPartRecord[],
	): Promise<PublicRaceRecording> {
		let payload: RaceVideoValidationWorkflowPayload;
		try {
			payload = await this.validationAuthority.ensure(
				recording.id,
				/* c8 ignore next -- validating-row D1 constraint requires completed_at. */
				recording.completedAt ?? this.clock().toISOString(),
			);
			await this.startValidation(payload);
		} catch {
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Race-recording validation could not be started',
			);
		}
		return this.public(recording, knownParts);
	}

	private async requireReadyRecording(identity: RaceRecordingIdentity): Promise<
		Readonly<{
			recording: RaceVideoRecord;
			contentType: PublicRaceRecording['contentType'];
		}>
	> {
		const recording = await this.requireRecording(identity);
		const validation = await this.validationAuthority.public(recording.id);
		if (recording.status !== 'validating' || validation?.status !== 'ready')
			throw authorityError(
				'CONFLICT',
				'Race recording is not ready for playback',
			);
		const contentType = validation.media
			? raceVideoPlaybackContentType(validation.media)
			: null;
		if (!contentType)
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Validated Race recording content metadata is unavailable',
			);
		return { recording, contentType };
	}

	private async discard(recording: RaceVideoRecord): Promise<boolean> {
		let deleting = recording;
		if (recording.status !== 'deleting') {
			const claimed = await this.database
				.update(raceVideo)
				.set({ status: 'deleting', updatedAt: this.clock().toISOString() })
				.where(
					and(
						eq(raceVideo.id, recording.id),
						eq(raceVideo.ownerId, recording.ownerId),
						eq(raceVideo.status, recording.status),
						notExists(
							this.database
								.select({ id: trackingRun.id })
								.from(trackingRunInput)
								.innerJoin(
									trackingRun,
									eq(trackingRun.id, trackingRunInput.runId),
								)
								.where(
									and(
										eq(trackingRunInput.raceVideoId, recording.id),
										eq(trackingRun.status, 'active'),
									),
								),
						),
					),
				)
				.returning()
				.get();
			if (!claimed) return false;
			deleting = claimed;
		}
		try {
			await this.bucket
				.resumeMultipartUpload(deleting.objectKey, deleting.multipartUploadId)
				.abort();
		} catch (error) {
			if (!isMissingMultipartUpload(error))
				throw authorityError(
					'STORAGE_UNAVAILABLE',
					'Private media upload could not be discarded',
				);
		}
		try {
			await this.bucket.delete(deleting.objectKey);
		} catch {
			throw authorityError(
				'STORAGE_UNAVAILABLE',
				'Completed private media could not be discarded',
			);
		}
		await this.database.batch([
			this.database
				.delete(raceVideoUploadPart)
				.where(eq(raceVideoUploadPart.raceVideoId, deleting.id)),
			this.database.delete(raceVideo).where(eq(raceVideo.id, deleting.id)),
		]);
		return true;
	}
}
