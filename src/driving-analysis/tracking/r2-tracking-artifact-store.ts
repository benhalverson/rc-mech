export type PrivateTrackingArtifactObject = {
	key: string;
	version: string;
	etag: string;
	uploaded: Date;
	byteCount: number;
	bytes: Uint8Array;
};

export type PrivateTrackingArtifactListing = {
	objects: readonly Pick<
		PrivateTrackingArtifactObject,
		'key' | 'version' | 'etag' | 'uploaded' | 'byteCount'
	>[];
	cursor: string | null;
};

export class TrackingArtifactStoreError extends Error {
	constructor(readonly code: 'OBJECT_TOO_LARGE' | 'OBJECT_CHANGED') {
		super(code);
		this.name = 'TrackingArtifactStoreError';
	}
}

export interface TrackingArtifactStore {
	read(
		key: string,
		maximumBytes: number,
		expectedEtag?: string,
	): Promise<PrivateTrackingArtifactObject | null>;
	putIfAbsent(
		key: string,
		bytes: Uint8Array,
		checksumSha256: string,
	): Promise<boolean>;
	list(
		prefix: string,
		cursor?: string,
	): Promise<PrivateTrackingArtifactListing>;
	delete(keys: readonly string[]): Promise<void>;
}

export class R2TrackingArtifactStore implements TrackingArtifactStore {
	constructor(private readonly bucket: R2Bucket) {}

	async read(
		key: string,
		maximumBytes: number,
		expectedEtag?: string,
	): Promise<PrivateTrackingArtifactObject | null> {
		const object = await this.bucket.get(
			key,
			expectedEtag === undefined
				? undefined
				: { onlyIf: { etagMatches: expectedEtag } },
		);
		if (!object) return null;
		if (!('body' in object))
			throw new TrackingArtifactStoreError('OBJECT_CHANGED');
		if (object.size > maximumBytes)
			throw new TrackingArtifactStoreError('OBJECT_TOO_LARGE');
		const bytes = new Uint8Array(await object.arrayBuffer());
		/* c8 ignore next -- R2ObjectBody size and its completed arrayBuffer can disagree only if the platform violates its object contract. */
		if (bytes.byteLength !== object.size)
			throw new TrackingArtifactStoreError('OBJECT_CHANGED');
		return {
			key: object.key,
			version: object.version,
			etag: object.etag,
			uploaded: object.uploaded,
			byteCount: object.size,
			bytes,
		};
	}

	async putIfAbsent(
		key: string,
		bytes: Uint8Array,
		checksumSha256: string,
	): Promise<boolean> {
		const onlyIf = new Headers({ 'If-None-Match': '*' });
		const stored = await this.bucket.put(key, bytes, {
			onlyIf,
			httpMetadata: {
				contentType: 'application/vnd.rc-mech.subject-observations+json',
				contentEncoding: 'gzip',
			},
			customMetadata: { sha256: checksumSha256 },
			sha256: hexBytes(checksumSha256),
		});
		return stored !== null;
	}

	async list(
		prefix: string,
		cursor?: string,
	): Promise<PrivateTrackingArtifactListing> {
		const listed = await this.bucket.list({ prefix, cursor, limit: 1000 });
		return {
			objects: listed.objects.map((object) => ({
				key: object.key,
				version: object.version,
				etag: object.etag,
				uploaded: object.uploaded,
				byteCount: object.size,
			})),
			cursor: listed.truncated ? (listed.cursor ?? null) : null,
		};
	}

	delete(keys: readonly string[]): Promise<void> {
		return this.bucket.delete([...keys]);
	}
}

export const trackingArtifactStore = (
	env: Pick<Env, 'ANALYSIS_MEDIA'>,
): TrackingArtifactStore => new R2TrackingArtifactStore(env.ANALYSIS_MEDIA);

const hexBytes = (value: string): Uint8Array =>
	Uint8Array.from(value.match(/.{2}/g) ?? [], (part) =>
		Number.parseInt(part, 16),
	);
