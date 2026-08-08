import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoiceRecorder } from './voice-recorder';

type RecorderHarness = {
	state: 'inactive' | 'recording';
	mimeType: string;
	ondataavailable: ((event: { data: Blob }) => void) | null;
	onerror: (() => void) | null;
	onstart: (() => void) | null;
	onstop: (() => void) | null;
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
};

const media = vi.hoisted(() => ({
	isSupported: vi.fn<() => Promise<boolean>>(),
	isTypeSupported: vi.fn<(type: string) => boolean>(),
	instances: [] as RecorderHarness[],
	autoStart: true,
	stopMode: 'stop' as 'stop' | 'error',
}));

vi.mock('extendable-media-recorder', () => ({
	isSupported: media.isSupported,
	MediaRecorder: class {
		state: 'inactive' | 'recording' = 'inactive';
		readonly mimeType: string;
		ondataavailable: ((event: { data: Blob }) => void) | null = null;
		onerror: (() => void) | null = null;
		onstart: (() => void) | null = null;
		onstop: (() => void) | null = null;
		readonly start = vi.fn(() => {
			this.state = 'recording';
			if (media.autoStart) queueMicrotask(() => this.onstart?.());
		});
		readonly stop = vi.fn(() => {
			this.state = 'inactive';
			if (media.stopMode === 'error') this.onerror?.();
			else this.onstop?.();
		});

		static isTypeSupported(type: string): boolean {
			return media.isTypeSupported(type);
		}

		constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
			this.mimeType = options?.mimeType ?? '';
			media.instances.push(this);
		}
	},
}));

describe('VoiceRecorder', () => {
	let stopTrack: ReturnType<typeof vi.fn>;
	let getUserMedia: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		stopTrack = vi.fn();
		getUserMedia = vi.fn(
			async () =>
				({
					getTracks: () => [{ stop: stopTrack }],
				}) as unknown as MediaStream,
		);
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
		media.isSupported.mockReset().mockResolvedValue(true);
		media.isTypeSupported.mockReset().mockReturnValue(false);
		media.instances.length = 0;
		media.autoStart = true;
		media.stopMode = 'stop';
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it.each([
		['navigator', undefined],
		['media devices', {}],
	] as const)('reports missing support without %s', async (_case, value) => {
		vi.stubGlobal('navigator', value);
		const recorder = new VoiceRecorder();
		await expect(recorder.detectSupport()).resolves.toBe(false);
		expect(recorder.checking()).toBe(false);
		expect(recorder.supported()).toBe(false);
	});

	it('reports unsupported and provider detection failures', async () => {
		const unavailable = new VoiceRecorder();
		media.isSupported.mockResolvedValueOnce(false);
		await expect(unavailable.detectSupport()).resolves.toBe(false);
		expect(unavailable.supported()).toBe(false);

		const failed = new VoiceRecorder();
		media.isSupported.mockRejectedValueOnce(new Error('detection failed'));
		await expect(failed.detectSupport()).resolves.toBe(false);
		expect(failed.supported()).toBe(false);
	});

	it('records non-empty audio, chooses a supported type, and releases tracks', async () => {
		media.isTypeSupported.mockImplementation((type) => type === 'audio/mp4');
		TestBed.configureTestingModule({ providers: [VoiceRecorder] });
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		await recorder.start();
		expect(getUserMedia).toHaveBeenCalledOnce();
		expect(getUserMedia).toHaveBeenCalledWith({
			audio: {
				echoCancellation: true,
				noiseSuppression: true,
				channelCount: 1,
			},
		});
		expect(recorder.recording()).toBe(true);
		const browserRecorder = media.instances[0];
		browserRecorder?.ondataavailable?.({ data: new Blob() });
		browserRecorder?.ondataavailable?.({ data: new Blob(['voice']) });
		const blob = await recorder.stop();
		expect(blob.type).toBe('audio/mp4');
		expect(blob.size).toBe(5);
		expect(stopTrack).toHaveBeenCalledOnce();
		expect(recorder.recording()).toBe(false);
	});

	it('does not report recording until the recorder start event fires', async () => {
		media.autoStart = false;
		const recorder = new VoiceRecorder();
		let startResolved = false;
		const starting = recorder.start().then(() => {
			startResolved = true;
		});
		await vi.waitFor(() => expect(media.instances).toHaveLength(1));
		await Promise.resolve();
		expect(startResolved).toBe(false);
		expect(recorder.starting()).toBe(true);
		expect(recorder.recording()).toBe(false);

		media.instances[0]?.onstart?.();
		await starting;
		expect(recorder.starting()).toBe(false);
		expect(recorder.recording()).toBe(true);
	});

	it('times live audio from the start event and resets on release', async () => {
		media.autoStart = false;
		vi.useFakeTimers({
			toFake: ['Date', 'setInterval', 'clearInterval'],
		});
		vi.setSystemTime(new Date('2026-08-08T01:00:00.000Z'));
		const recorder = new VoiceRecorder();
		const starting = recorder.start();
		await vi.waitFor(() => expect(media.instances).toHaveLength(1));
		vi.advanceTimersByTime(5_000);
		expect(recorder.elapsedSeconds()).toBe(0);

		media.instances[0]?.onstart?.();
		await starting;
		vi.advanceTimersByTime(2_100);
		expect(recorder.elapsedSeconds()).toBe(2);

		recorder.cancel();
		expect(recorder.elapsedSeconds()).toBe(0);
	});

	it('releases microphone resources when recorder startup fails', async () => {
		media.autoStart = false;
		const recorder = new VoiceRecorder();
		const starting = recorder.start();
		await vi.waitFor(() => expect(media.instances).toHaveLength(1));

		media.instances[0]?.onerror?.();
		await expect(starting).rejects.toThrow('could not start');
		expect(stopTrack).toHaveBeenCalledOnce();
		expect(recorder.starting()).toBe(false);
		expect(recorder.recording()).toBe(false);
	});

	it('uses the WebM fallback when no preferred recorder type is available', async () => {
		const recorder = new VoiceRecorder();
		await recorder.start();
		const browserRecorder = media.instances[0];
		browserRecorder?.ondataavailable?.({ data: new Blob(['voice']) });
		await expect(recorder.stop()).resolves.toMatchObject({
			type: 'audio/webm',
		});
	});

	it('rejects unavailable, failed, and empty recording completion', async () => {
		const recorder = new VoiceRecorder();
		await expect(recorder.stop()).rejects.toThrow('No recording');

		await recorder.start();
		media.stopMode = 'error';
		await expect(recorder.stop()).rejects.toThrow('could not finish');
		expect(recorder.recording()).toBe(false);

		media.stopMode = 'stop';
		await recorder.start();
		await expect(recorder.stop()).rejects.toThrow('empty');
	});

	it('rejects start when recording is unsupported or permission fails', async () => {
		const unsupported = new VoiceRecorder();
		media.isSupported.mockResolvedValueOnce(false);
		await expect(unsupported.start()).rejects.toThrow('not supported');

		const denied = new VoiceRecorder();
		getUserMedia.mockRejectedValueOnce(
			new DOMException('Denied', 'NotAllowedError'),
		);
		await expect(denied.start()).rejects.toMatchObject({
			name: 'NotAllowedError',
		});
		expect(denied.recording()).toBe(false);
	});

	it('cancels active audio and safely ignores repeated cancellation', async () => {
		const recorder = new VoiceRecorder();
		await recorder.start();
		const browserRecorder = media.instances[0];
		if (browserRecorder) browserRecorder.state = 'inactive';
		recorder.cancel();

		await recorder.start();
		recorder.cancel();
		recorder.cancel();
		expect(browserRecorder?.stop).not.toHaveBeenCalled();
		expect(media.instances[1]?.stop).toHaveBeenCalledOnce();
		expect(stopTrack).toHaveBeenCalledTimes(2);
		expect(recorder.recording()).toBe(false);
	});
});
