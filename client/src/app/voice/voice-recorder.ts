import { computed, Service, signal } from '@angular/core';
import type { IMediaRecorder } from 'extendable-media-recorder';

const loadRecorderModule = () => import('extendable-media-recorder');

const preferredMimeType = (
	Recorder: typeof import('extendable-media-recorder').MediaRecorder,
): string | undefined =>
	[
		'audio/webm;codecs=opus',
		'audio/mp4',
		'audio/ogg;codecs=opus',
		'audio/webm',
	].find((type) => Recorder.isTypeSupported(type));

@Service()
export class VoiceRecorder {
	private recorder: IMediaRecorder | null = null;
	private stream: MediaStream | null = null;
	private chunks: Blob[] = [];
	private elapsedTimer: ReturnType<typeof setInterval> | null = null;
	private recordingStartedAt = 0;
	private readonly availability = signal<'checking' | 'available' | 'missing'>(
		'checking',
	);
	readonly checking = computed(() => this.availability() === 'checking');
	readonly supported = computed(() => this.availability() === 'available');
	readonly starting = signal(false);
	readonly recording = signal(false);
	readonly elapsedSeconds = signal(0);

	async detectSupport(): Promise<boolean> {
		if (
			typeof navigator === 'undefined' ||
			!navigator.mediaDevices?.getUserMedia
		) {
			this.availability.set('missing');
			return false;
		}
		try {
			const { isSupported } = await loadRecorderModule();
			const supported = await isSupported();
			this.availability.set(supported ? 'available' : 'missing');
			return supported;
		} catch {
			this.availability.set('missing');
			return false;
		}
	}

	async start(): Promise<void> {
		if (this.starting() || this.recording()) return;
		this.starting.set(true);
		try {
			if (!this.supported() && !(await this.detectSupport()))
				throw new Error('Audio recording is not supported in this browser.');
			this.stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					channelCount: 1,
				},
			});
			this.chunks = [];
			const { MediaRecorder } = await loadRecorderModule();
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
				recorder.onstart = () => {
					this.recording.set(true);
					this.starting.set(false);
					this.startElapsedTimer();
					resolve();
				};
				recorder.onerror = () =>
					reject(new Error('The browser could not start the recording.'));
				recorder.start(1000);
			});
		} catch (error) {
			this.release();
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
				const blob = new Blob(this.chunks, {
					type: recorder.mimeType || 'audio/webm',
				});
				this.release();
				if (!blob.size) reject(new Error('The recording is empty.'));
				else resolve(blob);
			};
			recorder.stop();
		});
	}

	cancel(): void {
		if (this.recorder?.state !== 'inactive') this.recorder?.stop();
		this.release();
	}

	private release(): void {
		if (this.elapsedTimer !== null) clearInterval(this.elapsedTimer);
		this.elapsedTimer = null;
		this.recordingStartedAt = 0;
		for (const track of this.stream?.getTracks() ?? []) track.stop();
		this.stream = null;
		this.recorder = null;
		this.chunks = [];
		this.starting.set(false);
		this.recording.set(false);
		this.elapsedSeconds.set(0);
	}

	private startElapsedTimer(): void {
		this.recordingStartedAt = Date.now();
		this.elapsedSeconds.set(0);
		this.elapsedTimer = setInterval(() => {
			this.elapsedSeconds.set(
				Math.floor((Date.now() - this.recordingStartedAt) / 1000),
			);
		}, 1000);
	}
}
