export type PrivatePreparedTrackViewObject = {
	key: string;
	byteCount: number;
	checksumSha256: string | null;
	contentType: string | null;
	contentEncoding: string | null;
};

export interface PreparedTrackViewStore {
	head(key: string): Promise<PrivatePreparedTrackViewObject | null>;
	delete(keys: readonly string[]): Promise<void>;
}

export class R2PreparedTrackViewStore implements PreparedTrackViewStore {
	constructor(private readonly bucket: R2Bucket) {}

	async head(key: string): Promise<PrivatePreparedTrackViewObject | null> {
		const object = await this.bucket.head(key);
		if (!object) return null;
		return {
			key: object.key,
			byteCount: object.size,
			checksumSha256: object.customMetadata?.sha256 ?? null,
			contentType: object.httpMetadata?.contentType ?? null,
			contentEncoding: object.httpMetadata?.contentEncoding ?? null,
		};
	}

	delete(keys: readonly string[]): Promise<void> {
		return this.bucket.delete([...keys]);
	}
}

export const preparedTrackViewStore = (
	env: Pick<Env, 'ANALYSIS_MEDIA'>,
): PreparedTrackViewStore => new R2PreparedTrackViewStore(env.ANALYSIS_MEDIA);
