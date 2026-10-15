import {
	type SourceFrameCommand,
	type SourceFrameResult,
	sourceFrameCommandSchema,
} from './subject-frame-contracts';

const MAX_PENDING = 4;
const MAX_CACHE_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_ENTRIES = 8;
const CACHE_TTL_MS = 2 * 60 * 1000;

type CachedFrame = Readonly<{
	result: SourceFrameResult;
	expiresAt: number;
	bytes: number;
}>;

/** Serialize decoding within one recording's media container and reuse verified frames. */
export class SubjectFrameQueue {
	private tail: Promise<void> = Promise.resolve();
	private readonly pending = new Map<string, Promise<SourceFrameResult>>();
	private readonly cache = new Map<string, CachedFrame>();
	private cacheBytes = 0;

	constructor(
		private readonly load: (
			command: SourceFrameCommand,
		) => Promise<SourceFrameResult>,
		private readonly now: () => number = Date.now,
	) {}

	async select(value: SourceFrameCommand): Promise<SourceFrameResult> {
		const command = sourceFrameCommandSchema.parse(value);
		const key = JSON.stringify(command);
		const imageKey = JSON.stringify({ ...command, includeImage: true });
		const cached =
			this.read(key) ??
			(!command.includeImage ? this.read(imageKey) : undefined);
		if (cached) return this.forRequest(cached, command.includeImage);
		const pending =
			this.pending.get(key) ??
			(!command.includeImage ? this.pending.get(imageKey) : undefined);
		if (pending) return this.forRequest(await pending, command.includeImage);
		if (this.pending.size >= MAX_PENDING) throw new Error('SUBJECT_FRAME_BUSY');
		const result = this.tail.then(async () => {
			const available =
				this.read(key) ??
				(!command.includeImage ? this.read(imageKey) : undefined);
			if (available) return this.forRequest(available, command.includeImage);
			const frame = await this.load(command);
			this.remember(key, frame);
			return frame;
		});
		// Observe rejection immediately; a failed decode must not poison the queue.
		this.tail = result.then(
			() => undefined,
			() => undefined,
		);
		this.pending.set(key, result);
		try {
			return this.forRequest(await result, command.includeImage);
		} finally {
			this.pending.delete(key);
		}
	}

	private forRequest(
		result: SourceFrameResult,
		includeImage: boolean,
	): SourceFrameResult {
		return { ...result, imageBase64: includeImage ? result.imageBase64 : null };
	}

	private read(key: string): SourceFrameResult | undefined {
		const entry = this.cache.get(key);
		if (!entry) return undefined;
		this.cache.delete(key);
		if (entry.expiresAt <= this.now()) {
			this.cacheBytes -= entry.bytes;
			return undefined;
		}
		this.cache.set(key, entry);
		return entry.result;
	}

	private remember(key: string, result: SourceFrameResult): void {
		// Count UTF-16 conservatively, including key and fixed metadata overhead.
		const bytes = ((result.imageBase64?.length ?? 0) + key.length) * 2 + 512;
		if (bytes > MAX_CACHE_BYTES) return;
		while (
			this.cache.size >= MAX_CACHE_ENTRIES ||
			this.cacheBytes + bytes > MAX_CACHE_BYTES
		) {
			const oldest = this.cache.entries().next().value;
			if (!oldest) break;
			this.cache.delete(oldest[0]);
			this.cacheBytes -= oldest[1].bytes;
		}
		this.cache.set(key, {
			result: { ...result },
			expiresAt: this.now() + CACHE_TTL_MS,
			bytes,
		});
		this.cacheBytes += bytes;
	}
}
