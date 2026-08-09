import { computed, inject, type OnDestroy, Service } from '@angular/core';
import { patchState, signalStore, withMethods, withState } from '@ngrx/signals';

const preferredMimeType = (
	Recorder: typeof MediaRecorder,
): string | undefined => {
	for (const type of [
		'audio/webm;codecs=opus',
		'audio/mp4',
		'audio/ogg;codecs=opus',
		'audio/webm',
	]) {
		if (Recorder.isTypeSupported(type)) return type;
	}
	return undefined;
};

type VoiceRecorderState = {
	availability: 'checking' | 'available' | 'missing';
	starting: boolean;
	recording: boolean;
	elapsedSeconds: number;
	inputLevel: number;
	audioDetected: boolean;
	inputMuted: boolean;
};

const initialState: VoiceRecorderState = {
	availability: 'checking',
	starting: false,
	recording: false,
	elapsedSeconds: 0,
	inputLevel: 0,
	audioDetected: false,
	inputMuted: false,
};

export const VoiceRecorderStore = signalStore(
	{ providedIn: 'root' },
	withState(initialState),
	withMethods((store) => ({
		set(values: Partial<VoiceRecorderState>): void {
			patchState(store, values);
		},
		reset(): void {
			patchState(store, {
				...initialState,
				availability: store.availability(),
			});
		},
	})),
);

type AudioContextConstructor = typeof AudioContext & {
	new (): AudioContext;
};

@Service()
export class VoiceRecorder implements OnDestroy {
	private readonly state = inject(VoiceRecorderStore);
	private recorder: MediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private audioContext: AudioContext | null = null;
	private analyser: AnalyserNode | null = null;
	private levelTimer: ReturnType<typeof setInterval> | null = null;
	private levelMonitoring = false;
	private chunks: Blob[] = [];
	private elapsedTimer: ReturnType<typeof setInterval> | null = null;
	private recordingStartedAt = 0;
	private aboveThresholdSince: number | null = null;
	private startGeneration = 0;
	private rejectStart: ((error: Error) => void) | null = null;
	private readonly trackHandlers = new Map<
		MediaStreamTrack,
		{
			mute: () => void;
			unmute: () => void;
			ended: () => void;
		}
	>();
	readonly checking = computed(() => this.state.availability() === 'checking');
	readonly supported = computed(
		() => this.state.availability() === 'available',
	);
	readonly starting = this.state.starting;
	readonly recording = this.state.recording;
	readonly elapsedSeconds = this.state.elapsedSeconds;
	readonly inputLevel = this.state.inputLevel;
	readonly audioDetected = this.state.audioDetected;
	readonly inputMuted = this.state.inputMuted;

	async detectSupport(): Promise<boolean> {
		const Recorder = globalThis.MediaRecorder;
		if (
			typeof navigator === 'undefined' ||
			!navigator.mediaDevices?.getUserMedia ||
			typeof Recorder === 'undefined'
		) {
			this.state.set({ availability: 'missing' });
			return false;
		}
		this.state.set({ availability: 'available' });
		return true;
	}

	async start(): Promise<void> {
		if (this.starting() || this.recording()) return;
		const generation = ++this.startGeneration;
		this.state.set({ starting: true });
		try {
			if (!this.supported() && !(await this.detectSupport()))
				throw new Error('Audio recording is not supported in this browser.');
			if (generation !== this.startGeneration)
				throw new Error('The recording was cancelled.');
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					channelCount: 1,
				},
			});
			if (generation !== this.startGeneration) {
				for (const track of stream.getTracks()) track.stop();
				throw new Error('The recording was cancelled.');
			}
			this.stream = stream;
			this.chunks = [];
			const audioTracks = this.stream.getAudioTracks();
			this.state.set({
				inputLevel: 0,
				audioDetected: false,
				inputMuted: audioTracks.some(
					(track) => track.muted || track.readyState === 'ended',
				),
			});
			for (const track of audioTracks) {
				const handlers = {
					mute: () => this.state.set({ inputMuted: true }),
					unmute: () => this.state.set({ inputMuted: false }),
					ended: () => this.state.set({ inputMuted: true }),
				};
				track.addEventListener('mute', handlers.mute);
				track.addEventListener('unmute', handlers.unmute);
				track.addEventListener('ended', handlers.ended);
				this.trackHandlers.set(track, handlers);
			}
			this.setupLevelMonitor(this.stream);
			const mimeType = preferredMimeType(MediaRecorder);
			const recorder = new MediaRecorder(
				this.stream,
				mimeType ? { mimeType, audioBitsPerSecond: 64_000 } : undefined,
			);
			this.recorder = recorder;
			recorder.ondataavailable = ({ data }) => {
				if (data.size) this.chunks.push(data);
			};
			await new Promise<void>((resolve, reject) => {
				this.rejectStart = reject;
				recorder.onstart = () => {
					this.rejectStart = null;
					this.state.set({ recording: true, starting: false });
					this.startElapsedTimer();
					resolve();
				};
				recorder.onerror = () => {
					this.rejectStart = null;
					reject(new Error('The browser could not start the recording.'));
				};
				recorder.start();
			});
		} catch (error) {
			if (generation === this.startGeneration) this.release();
			throw error;
		}
	}

	stop(): Promise<Blob> {
		const recorder = this.recorder;
		if (!recorder || recorder.state === 'inactive')
			return Promise.reject(new Error('No recording is in progress.'));
		return new Promise<Blob>((resolve, reject) => {
			recorder.onerror = () => {
				this.release();
				reject(new Error('The browser could not finish the recording.'));
			};
			recorder.onstop = () => {
				const detected = this.audioDetected();
				const monitored = this.levelMonitoring;
				const blob = new Blob(this.chunks, {
					type: recorder.mimeType || 'audio/webm',
				});
				this.release();
				if (!blob.size) reject(new Error('The recording is empty.'));
				else if (monitored && !detected)
					reject(
						new Error(
							'No microphone audio was detected. Check the selected input and try again.',
						),
					);
				else resolve(blob);
			};
			recorder.stop();
		});
	}

	cancel(): void {
		this.startGeneration += 1;
		this.rejectStart?.(new Error('The recording was cancelled.'));
		this.rejectStart = null;
		const recorder = this.recorder;
		if (recorder && recorder.state !== 'inactive') {
			recorder.ondataavailable = null;
			recorder.onstart = null;
			recorder.onstop = null;
			recorder.onerror = null;
			recorder.stop();
		}
		this.release();
	}

	ngOnDestroy(): void {
		this.cancel();
	}

	private setupLevelMonitor(stream: MediaStream): void {
		this.levelMonitoring = false;
		const Context = (globalThis.AudioContext ??
			(
				globalThis as typeof globalThis & {
					webkitAudioContext?: AudioContextConstructor;
				}
			).webkitAudioContext) as AudioContextConstructor | undefined;
		if (!Context) return;
		try {
			this.audioContext = new Context();
			const source = this.audioContext.createMediaStreamSource(stream);
			this.analyser = this.audioContext.createAnalyser();
			this.analyser.fftSize = 2048;
			source.connect(this.analyser);
			const samples = new Float32Array(this.analyser.fftSize);
			this.levelTimer = setInterval(() => {
				if (!this.analyser) return;
				this.analyser.getFloatTimeDomainData(samples);
				let sum = 0;
				for (const sample of samples) sum += sample * sample;
				const rms = Math.sqrt(sum / samples.length);
				const decibels = rms > 0 ? 20 * Math.log10(rms) : -Infinity;
				this.state.set({
					inputLevel: Math.max(0, Math.min(1, (decibels + 60) / 60)),
				});
				const now = Date.now();
				if (decibels > -50) {
					this.aboveThresholdSince ??= now;
					if (now - this.aboveThresholdSince >= 150)
						this.state.set({ audioDetected: true });
				} else {
					this.aboveThresholdSince = null;
				}
			}, 50);
			this.levelMonitoring = true;
		} catch {
			this.audioContext?.close();
			this.audioContext = null;
			this.analyser = null;
		}
	}

	private release(): void {
		if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
		if (this.levelTimer !== null) clearInterval(this.levelTimer);
		this.elapsedTimer = null;
		this.levelTimer = null;
		this.levelMonitoring = false;
		this.recordingStartedAt = 0;
		this.analyser?.disconnect();
		this.analyser = null;
		void this.audioContext?.close();
		this.audioContext = null;
		for (const track of this.stream?.getTracks() ?? []) {
			const handlers = this.trackHandlers.get(track);
			if (handlers) {
				track.removeEventListener('mute', handlers.mute);
				track.removeEventListener('unmute', handlers.unmute);
				track.removeEventListener('ended', handlers.ended);
			}
			track.stop();
		}
		this.trackHandlers.clear();
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
		this.aboveThresholdSince = null;
		this.state.reset();
	}

	private startElapsedTimer(): void {
		this.recordingStartedAt = Date.now();
		this.state.set({ elapsedSeconds: 0 });
		this.elapsedTimer = setInterval(() => {
			this.state.set({
				elapsedSeconds: Math.floor(
					(Date.now() - this.recordingStartedAt) / 1000,
				),
			});
		}, 1000);
	}
}
