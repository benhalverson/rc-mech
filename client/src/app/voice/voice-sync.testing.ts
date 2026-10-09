import { signal } from '@angular/core';
import { vi } from 'vitest';
import type {
	PendingVoiceCapture,
	VoiceContextCar,
	VoiceUpdate,
} from './voice.models';
import type { VoiceCapture } from './voice-sync.models';
import type { VoiceLocalOutcome } from './voice-workspace-store';
/**
 * In-memory Voice coordinator double for route/component specs. Exposes the
 * signals and command spies those consumers use without opening IndexedDB or
 * calling HTTP; durable behavior is tested at the storage/coordinator boundary.
 */
export class FakeVoiceWorkspace {
	readonly available = signal(false);
	readonly remoteAvailable = signal(true);
	readonly captures = signal<readonly VoiceCapture[]>([]);
	readonly updates = signal<readonly VoiceUpdate[]>([]);
	readonly cars = signal<readonly VoiceContextCar[]>([]);
	readonly failure = signal('');
	readonly outcome = signal<VoiceLocalOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly keep =
		vi.fn<
			(
				command: Readonly<{ capture: PendingVoiceCapture; requestId: string }>,
			) => void
		>();
	readonly discard =
		vi.fn<(command: Readonly<{ id: string; requestId: string }>) => void>();
	readonly synchronize = vi.fn();
	readonly retry = vi.fn();
	readonly refresh = vi.fn();
}
export const voiceCaptureFixture: VoiceCapture = {
	id: 'capture',
	ownerKey: 'owner',
	carId: 'car',
	driveSessionId: null,
	text: 'Rear slid on entry',
	contentType: 'text/plain',
	fileName: 'capture.txt',
	createdAt: '2026-10-09T12:00:00.000Z',
	status: 'queued',
	error: null,
	phase: 'upload',
	dependencies: [],
};
export const voiceUpdateFixture: VoiceUpdate = {
	id: 'capture',
	carId: 'car',
	driveSessionId: null,
	status: 'pending',
	contentType: null,
	fileName: null,
	byteSize: 0,
	audioUrl: null,
	transcript: 'Rear slid on entry',
	draft: null,
	corrections: [],
	clarificationPrompt: null,
	error: null,
	confirmedAt: null,
	artifactDeletedAt: null,
	createdAt: '2026-10-09T12:00:00.000Z',
	updatedAt: '2026-10-09T12:00:00.000Z',
	results: [],
};
