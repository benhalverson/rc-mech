import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { VoiceRecorder } from './voice-recorder';

type TrackHarness = MediaStreamTrack & {
	dispatch: (type: 'mute' | 'unmute' | 'ended') => void;
	stop: ReturnType<typeof vi.fn>;
};

type RecorderHarness = MediaRecorder & {
	start: ReturnType<typeof vi.fn>;
	stop: ReturnType<typeof vi.fn>;
	ondataavailable: ((event: BlobEvent) => void) | null;
	onstart: (() => void) | null;
	onstop: (() => void) | null;
	onerror: (() => void) | null;
};

const harness = vi.hoisted(() => ({
	instances: [] as RecorderHarness[],
	tracks: [] as TrackHarness[],
	samples: 0.1,
	startMode: 'start' as 'start' | 'error',
	stopMode: 'stop' as 'stop' | 'error',
	emitFinal: true,
	contextMode: 'works' as 'works' | 'error',
	includeOrphan: false,
	trackMuted: false,
	trackReadyState: 'live' as MediaStreamTrackState,
}));

class FakeAnalyser {
	fftSize = 0;
	connect = vi.fn();
	disconnect = vi.fn();
	getFloatTimeDomainData = vi.fn((values: Float32Array) =>
		values.fill(harness.samples),
	);
}

class FakeAudioContext {
	analyser = new FakeAnalyser();
	close = vi.fn(async () => undefined);
	createMediaStreamSource = vi.fn(() => {
		if (harness.contextMode === 'error')
			throw new Error('analyser unavailable');
		return { connect: vi.fn() };
	});
	createAnalyser = vi.fn(() => this.analyser);
}

class FakeMediaRecorder {
	static isTypeSupported = vi.fn((type: string) => type === 'audio/webm');
	state: 'inactive' | 'recording' = 'inactive';
	mimeType = 'audio/webm';
	ondataavailable: ((event: BlobEvent) => void) | null = null;
	onstart: (() => void) | null = null;
	onstop: (() => void) | null = null;
	onerror: (() => void) | null = null;
	start = vi.fn((...args: unknown[]) => {
		this.state = 'recording';
		if (args.length) throw new Error('timeslice must not be used');
		queueMicrotask(() =>
			harness.startMode === 'error' ? this.onerror?.() : this.onstart?.(),
		);
	});
	stop = vi.fn(() => {
		this.state = 'inactive';
		if (harness.stopMode === 'error') this.onerror?.();
		else {
			this.ondataavailable?.({ data: new Blob() } as BlobEvent);
			if (harness.emitFinal)
				this.ondataavailable?.({
					data: new Blob(['final audio']),
				} as BlobEvent);
			this.onstop?.();
		}
	});

	constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
		harness.instances.push(this as unknown as RecorderHarness);
	}
}

const createTrack = (): TrackHarness => {
	const listeners = new Map<string, EventListener[]>();
	const stop = vi.fn();
	return {
		kind: 'audio',
		id: 'track-1',
		label: 'Synthetic microphone',
		enabled: true,
		muted: harness.trackMuted,
		readyState: harness.trackReadyState,
		contentHint: '',
		stop,
		clone: vi.fn(),
		getCapabilities: vi.fn(),
		getConstraints: vi.fn(),
		getSettings: vi.fn(),
		applyConstraints: vi.fn(),
		addEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			const values = listeners.get(type) ?? [];
			values.push(listener as EventListener);
			listeners.set(type, values);
		},
		removeEventListener: (
			type: string,
			listener: EventListenerOrEventListenerObject,
		) => {
			listeners.set(
				type,
				(listeners.get(type) ?? []).filter((item) => item !== listener),
			);
		},
		dispatch: (type: 'mute' | 'unmute' | 'ended') => {
			for (const listener of listeners.get(type) ?? [])
				listener(new Event(type));
		},
	} as unknown as TrackHarness;
};

describe('VoiceRecorder', () => {
	let getUserMedia: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		TestBed.configureTestingModule({ providers: [VoiceRecorder] });
		harness.instances.length = 0;
		harness.tracks.length = 0;
		harness.samples = 0.1;
		harness.startMode = 'start';
		harness.stopMode = 'stop';
		harness.emitFinal = true;
		harness.contextMode = 'works';
		harness.includeOrphan = false;
		harness.trackMuted = false;
		harness.trackReadyState = 'live';
		getUserMedia = vi.fn(async () => {
			const track = createTrack();
			const orphan = createTrack();
			harness.tracks.push(track);
			return {
				getTracks: () => (harness.includeOrphan ? [track, orphan] : [track]),
				getAudioTracks: () => [track],
			} as unknown as MediaStream;
		});
		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
		vi.stubGlobal('MediaRecorder', FakeMediaRecorder);
		vi.stubGlobal('AudioContext', FakeAudioContext);
	});

	afterEach(() => {
		TestBed.resetTestingModule();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('detects native support and records the final data event without timeslices', async () => {
		vi.useFakeTimers();
		const recorder = TestBed.inject(VoiceRecorder);
		expect(recorder.checking()).toBe(true);
		await expect(recorder.detectSupport()).resolves.toBe(true);
		expect(recorder.checking()).toBe(false);
		await recorder.start();
		await recorder.start();
		vi.advanceTimersByTime(200);
		const blob = await recorder.stop();
		expect(blob.size).toBeGreaterThan(0);
		expect(harness.instances[0]?.start).toHaveBeenCalledWith();
		expect(harness.instances[0]?.stop).toHaveBeenCalledOnce();
	});

	it('requires 150ms of input above -50 dBFS', async () => {
		vi.useFakeTimers();
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		vi.advanceTimersByTime(100);
		expect(recorder.audioDetected()).toBe(false);
		vi.advanceTimersByTime(100);
		expect(recorder.audioDetected()).toBe(true);
		await expect(recorder.stop()).resolves.toBeInstanceOf(Blob);
	});

	it('uses the browser default MIME type when no preferred type is supported', async () => {
		vi.useFakeTimers();
		FakeMediaRecorder.isTypeSupported.mockReturnValue(false);
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		vi.advanceTimersByTime(200);
		const browserRecorder = harness.instances[0];
		if (browserRecorder)
			Object.defineProperty(browserRecorder, 'mimeType', { value: '' });
		await expect(recorder.stop()).resolves.toMatchObject({
			type: 'audio/webm',
		});
	});

	it('rejects silent recordings and cleans every resource', async () => {
		harness.samples = 0;
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		await expect(recorder.stop()).rejects.toThrow(
			'No microphone audio was detected',
		);
		expect(harness.tracks[0]?.stop).toHaveBeenCalledOnce();
		expect(recorder.recording()).toBe(false);
		expect(recorder.inputLevel()).toBe(0);
	});

	it('tracks mute events and cancels without retaining final data', async () => {
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		harness.tracks[0]?.dispatch('mute');
		expect(recorder.inputMuted()).toBe(true);
		harness.tracks[0]?.dispatch('unmute');
		expect(recorder.inputMuted()).toBe(false);
		harness.tracks[0]?.dispatch('ended');
		expect(recorder.inputMuted()).toBe(true);
		recorder.cancel();
		expect(harness.tracks[0]?.stop).toHaveBeenCalledOnce();
		expect(recorder.recording()).toBe(false);
	});

	it.each([
		['muted', true, 'live'],
		['ended', false, 'ended'],
	] as const)(
		'reflects an initially %s input track',
		async (_case, muted, state) => {
			harness.trackMuted = muted;
			harness.trackReadyState = state;
			const recorder = TestBed.inject(VoiceRecorder);
			await recorder.start();
			expect(recorder.inputMuted()).toBe(true);
			recorder.cancel();
		},
	);

	it('reports missing native recorder support', async () => {
		vi.stubGlobal('MediaRecorder', undefined);
		const recorder = TestBed.inject(VoiceRecorder);
		await expect(recorder.detectSupport()).resolves.toBe(false);
		expect(recorder.supported()).toBe(false);
	});

	it('handles missing media APIs and microphone permission failures', async () => {
		const recorder = TestBed.inject(VoiceRecorder);
		vi.stubGlobal('navigator', undefined);
		await expect(recorder.detectSupport()).resolves.toBe(false);
		await expect(recorder.start()).rejects.toThrow('not supported');

		vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
		getUserMedia.mockRejectedValueOnce(
			new DOMException('Denied', 'NotAllowedError'),
		);
		await expect(recorder.start()).rejects.toMatchObject({
			name: 'NotAllowedError',
		});
	});

	it('cleans up when native startup or completion fails', async () => {
		const recorder = TestBed.inject(VoiceRecorder);
		harness.startMode = 'error';
		await expect(recorder.start()).rejects.toThrow('could not start');
		expect(harness.tracks[0]?.stop).toHaveBeenCalledOnce();

		harness.startMode = 'start';
		await recorder.start();
		harness.stopMode = 'error';
		await expect(recorder.stop()).rejects.toThrow('could not finish');
		expect(recorder.recording()).toBe(false);
	});

	it('rejects inactive and empty completions and updates elapsed time', async () => {
		vi.useFakeTimers();
		const recorder = TestBed.inject(VoiceRecorder);
		await expect(recorder.stop()).rejects.toThrow('No recording');
		await recorder.start();
		vi.advanceTimersByTime(1_000);
		expect(recorder.elapsedSeconds()).toBe(1);
		harness.emitFinal = false;
		await expect(recorder.stop()).rejects.toThrow('empty');
		recorder.cancel();
		await expect(recorder.stop()).rejects.toThrow('No recording');
	});

	it('resets detection after quiet input and supports browsers without AudioContext', async () => {
		vi.useFakeTimers();
		const recorder = TestBed.inject(VoiceRecorder);
		await recorder.start();
		(recorder as unknown as { analyser: AnalyserNode | null }).analyser = null;
		vi.advanceTimersByTime(50);
		recorder.cancel();
		await recorder.start();
		vi.advanceTimersByTime(50);
		harness.samples = 0;
		vi.advanceTimersByTime(50);
		harness.samples = 0.1;
		vi.advanceTimersByTime(200);
		expect(recorder.audioDetected()).toBe(true);
		recorder.cancel();

		vi.stubGlobal('AudioContext', undefined);
		const noAnalyser = TestBed.inject(VoiceRecorder);
		await noAnalyser.start();
		await expect(noAnalyser.stop()).resolves.toBeInstanceOf(Blob);

		vi.stubGlobal('AudioContext', FakeAudioContext);
		harness.contextMode = 'error';
		const brokenAnalyser = TestBed.inject(VoiceRecorder);
		harness.includeOrphan = true;
		await brokenAnalyser.start();
		await expect(brokenAnalyser.stop()).resolves.toBeInstanceOf(Blob);
	});
});
