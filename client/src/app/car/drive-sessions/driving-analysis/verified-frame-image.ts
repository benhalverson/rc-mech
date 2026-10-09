import { computed, linkedSignal, type Signal } from '@angular/core';

/** One immutable presentation selection, including its exact source identity. */
export type VerifiedFrameImageSource = Readonly<{
	contentUrl: string;
	identity: string;
}>;

/** One rendered image attempt; object identity fences late DOM events and retries. */
export type VerifiedFrameImageAttempt = Readonly<{
	source: VerifiedFrameImageSource;
}>;

type ImageState = Readonly<{
	image: VerifiedFrameImageAttempt;
	status: 'loading' | 'loaded' | 'failed';
}>;

/** Start an unconfirmed image attempt for this exact immutable selection. */
function loading(source: VerifiedFrameImageSource | null): ImageState | null {
	return source ? { image: { source }, status: 'loading' } : null;
}

/** Share local image readiness without moving DOM state into workflow stores. */
export function verifiedFrameImage(
	source: Signal<VerifiedFrameImageSource | null>,
) {
	const state = linkedSignal({ source, computation: loading });
	const failed = computed(() => state()?.status === 'failed');
	const ready = computed(() => state()?.status === 'loaded');
	const images = computed(() => {
		const current = state();
		return current && current.status !== 'failed' ? [current.image] : [];
	});
	/** Accept only events from the image attempt currently rendered by this editor. */
	function settle(
		image: VerifiedFrameImageAttempt,
		status: 'loaded' | 'failed',
	): void {
		const current = state();
		if (!current || image !== current.image || current.status === 'failed')
			return;
		state.set({ image, status });
	}
	/** Recreate the same source image with a new token and require a fresh load. */
	function retry(): void {
		state.set(loading(source()));
	}
	return {
		ready,
		failed,
		images,
		/** Record successful loading for the current image attempt. */
		loaded: (image: VerifiedFrameImageAttempt) => settle(image, 'loaded'),
		/** Record a failure for the current image attempt. */
		error: (image: VerifiedFrameImageAttempt) => settle(image, 'failed'),
		retry,
	};
}
