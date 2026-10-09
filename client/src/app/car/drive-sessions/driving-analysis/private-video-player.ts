import {
	Directive,
	ElementRef,
	effect,
	Injectable,
	inject,
	input,
	signal,
} from '@angular/core';

/** Creates isolated native playback sessions for creators sharing one route. */
@Injectable()
export class PrivateVideoPlayerCapability {
	/** Allocate a handle whose lifetime belongs to one rendered creator. */
	create(): PrivateVideoPlayerSession {
		return new PrivateVideoPlayerSession();
	}
}

/** Owns native media operations without HTTP, workflow, or presentation state. */
export class PrivateVideoPlayerSession {
	private readonly timestamp = signal(0);
	private readonly active = signal(false);
	private readonly error = signal<'play' | 'seek' | 'media' | null>(null);
	readonly currentTimestampMs = this.timestamp.asReadonly();
	readonly playing = this.active.asReadonly();
	readonly failure = this.error.asReadonly();
	private player: HTMLVideoElement | null = null;
	private durationMs = 0;
	private generation = 0;
	private binding = 0;
	private release: (() => void) | null = null;

	/** Replace the native handle and invalidate listeners and pending play results. */
	bind(player: HTMLVideoElement, durationMs: number): void {
		this.dispose();
		this.player = player;
		this.durationMs = durationMs;
		const binding = this.binding;
		const listen = (event: string, update: () => void): (() => void) => {
			const listener = (): void => {
				if (this.player === player && this.binding === binding) update();
			};
			player.addEventListener(event, listener);
			return () => player.removeEventListener(event, listener);
		};
		const removals = [
			listen('timeupdate', () =>
				this.timestamp.set(this.clamp(player.currentTime * 1000)),
			),
			listen('play', () => this.active.set(true)),
			listen('pause', () => this.active.set(false)),
			listen('error', () => {
				this.active.set(false);
				this.error.set('media');
			}),
		];
		this.release = () => {
			for (const remove of removals) remove();
		};
	}

	/** Seek in absolute milliseconds; retain the previous timestamp on failure. */
	seek(timestampMs: number): void {
		const player = this.player;
		if (!player || !Number.isFinite(timestampMs)) return;
		const timestamp = this.clamp(timestampMs);
		try {
			player.currentTime = timestamp / 1000;
			this.timestamp.set(timestamp);
			this.error.set(null);
		} catch {
			this.error.set('seek');
		}
	}

	/** Toggle playback and fence rejected promises after pause or replacement. */
	toggle(): void {
		const player = this.player;
		if (!player) return;
		if (!player.paused) {
			this.pause();
			return;
		}
		const generation = ++this.generation;
		// Listener lifetime is independent of individual play attempts.
		this.error.set(null);
		try {
			void player.play().catch(() => {
				if (this.player === player && this.generation === generation) {
					this.active.set(false);
					this.error.set('play');
				}
			});
		} catch {
			this.active.set(false);
			this.error.set('play');
		}
	}

	/** Pause synchronously before the caller requests a verified source frame. */
	pause(): void {
		this.generation++;
		this.player?.pause();
		this.active.set(false);
	}

	/** Detach listeners before pausing and discard the native handle. */
	dispose(): void {
		this.binding++;
		this.generation++;
		this.release?.();
		this.release = null;
		const player = this.player;
		this.player = null;
		player?.pause();
		this.timestamp.set(0);
		this.active.set(false);
		this.error.set(null);
	}

	/** Normalize native time and requested positions to recording bounds. */
	private clamp(timestampMs: number): number {
		return Math.min(this.durationMs, Math.max(0, Math.round(timestampMs)));
	}
}

/** Bind a rendered video to its isolated session without exposing the native handle. */
@Directive({ selector: 'video[privateVideoPlayer]' })
export class PrivateVideoPlayerBinding {
	readonly privateVideoPlayer = input.required<PrivateVideoPlayerSession>();
	readonly durationMs = input.required<number>();
	readonly sourceIdentity = input.required<string>();
	private readonly element = inject<ElementRef<HTMLVideoElement>>(ElementRef);

	/** Keep binding lifetime aligned with the element and meaningful source identity. */
	constructor() {
		effect((onCleanup) => {
			const session = this.privateVideoPlayer();
			this.sourceIdentity();
			session.bind(this.element.nativeElement, this.durationMs());
			onCleanup(() => session.dispose());
		});
	}
}
