import { describe, expect, it, vi } from 'vitest';
import { PrivateVideoPlayerCapability } from './private-video-player';

/** Provide controllable native playback while retaining real DOM event dispatch. */
function video() {
	const element = document.createElement('video');
	const pause = vi.fn();
	const play = vi.fn(() => Promise.resolve());
	Object.defineProperties(element, {
		pause: { value: pause },
		play: { value: play },
		paused: { value: true, configurable: true },
	});
	return { element, pause, play };
}

describe('PrivateVideoPlayerCapability', () => {
	it('isolates creators, normalizes time, and releases listeners before pause', () => {
		const capability = new PrivateVideoPlayerCapability();
		const session = capability.create();
		const other = capability.create();
		const first = video();
		const second = video();
		session.seek(1);
		session.toggle();
		session.pause();
		session.bind(first.element, 1000);
		other.bind(second.element, 2000);
		first.element.currentTime = 1.9;
		first.element.dispatchEvent(new Event('timeupdate'));
		expect(session.currentTimestampMs()).toBe(1000);
		expect(other.currentTimestampMs()).toBe(0);
		first.element.currentTime = -1;
		first.element.dispatchEvent(new Event('timeupdate'));
		expect(session.currentTimestampMs()).toBe(0);
		first.element.currentTime = 0.1235;
		first.element.dispatchEvent(new Event('timeupdate'));
		expect(session.currentTimestampMs()).toBe(124);
		first.element.dispatchEvent(new Event('play'));
		expect(session.playing()).toBe(true);
		first.element.dispatchEvent(new Event('pause'));
		expect(session.playing()).toBe(false);
		first.element.dispatchEvent(new Event('error'));
		expect(session.failure()).toBe('media');
		session.bind(second.element, 1000);
		expect(first.pause).toHaveBeenCalledOnce();
		first.element.dispatchEvent(new Event('play'));
		expect(session.playing()).toBe(false);
		second.pause.mockImplementation(() =>
			second.element.dispatchEvent(new Event('play')),
		);
		session.dispose();
		expect(session.playing()).toBe(false);
		expect(session.failure()).toBeNull();
		session.dispose();
		other.dispose();
	});

	it('rejects invalid seeks and preserves the last position on native seek failure', () => {
		const session = new PrivateVideoPlayerCapability().create();
		const native = video();
		session.bind(native.element, 1000);
		session.seek(250.5);
		expect(native.element.currentTime).toBe(0.251);
		expect(session.currentTimestampMs()).toBe(251);
		session.seek(Number.NaN);
		expect(session.currentTimestampMs()).toBe(251);
		Object.defineProperty(native.element, 'currentTime', {
			configurable: true,
			set: () => {
				throw new Error('Seek unavailable');
			},
		});
		session.seek(500);
		expect(session.failure()).toBe('seek');
		expect(session.currentTimestampMs()).toBe(251);
		Object.defineProperty(native.element, 'currentTime', {
			value: 0,
			writable: true,
		});
		session.seek(500);
		expect(session.failure()).toBeNull();
		expect(session.currentTimestampMs()).toBe(500);
		session.dispose();
	});

	it('handles rejected and synchronous play failures and allows retry', async () => {
		const session = new PrivateVideoPlayerCapability().create();
		const native = video();
		session.bind(native.element, 1000);
		native.play.mockRejectedValueOnce(new Error('Playback denied'));
		session.toggle();
		await Promise.resolve();
		expect(session.failure()).toBe('play');
		native.play.mockImplementationOnce(() => {
			throw new Error('Native failure');
		});
		session.toggle();
		expect(session.failure()).toBe('play');
		session.toggle();
		await Promise.resolve();
		native.element.dispatchEvent(new Event('play'));
		expect(session.playing()).toBe(true);
		expect(session.failure()).toBeNull();
		Object.defineProperty(native.element, 'paused', { value: false });
		session.toggle();
		expect(native.pause).toHaveBeenCalledOnce();
		expect(session.playing()).toBe(false);
		session.dispose();
	});

	it('ignores obsolete promises after pause, retry, replacement and disposal', async () => {
		const session = new PrivateVideoPlayerCapability().create();
		const first = video();
		const second = video();
		let reject: (error: Error) => void = () => undefined;
		first.play.mockImplementation(
			() =>
				new Promise<void>((_, failure) => {
					reject = failure;
				}),
		);
		session.bind(first.element, 1000);
		for (const invalidate of [
			() => session.pause(),
			() => session.toggle(),
			() => session.bind(second.element, 1000),
			() => session.dispose(),
		]) {
			session.bind(first.element, 1000);
			session.toggle();
			const rejectOld = reject;
			invalidate();
			rejectOld(new Error('Obsolete failure'));
			await Promise.resolve();
			expect(session.failure()).toBeNull();
		}
	});

	it('fences queued listeners even when the same element is rebound', () => {
		const session = new PrivateVideoPlayerCapability().create();
		const native = video();
		const listeners: EventListener[] = [];
		vi.spyOn(native.element, 'addEventListener').mockImplementation(
			(_, listener) => {
				listeners.push(listener as EventListener);
			},
		);
		session.bind(native.element, 1000);
		session.bind(native.element, 1000);
		for (const listener of listeners.slice(0, 4)) listener(new Event('play'));
		expect(session.playing()).toBe(false);
		expect(session.failure()).toBeNull();
		session.dispose();
	});
});
