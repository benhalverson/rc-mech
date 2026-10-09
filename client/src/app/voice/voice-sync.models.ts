/**
 * Durable Voice capture phases and retained originals shared by storage, migration, and background upload/processing.
 */

import type { PendingVoiceCapture, VoiceUpdate } from './voice.models';
export type VoiceCapture = PendingVoiceCapture &
	Readonly<{
		phase: 'upload' | 'processing' | 'retained';
		dependencies: readonly string[];
		remote?: VoiceUpdate;
	}>;
export type VoiceWorkingCopy = Readonly<{
	captures: readonly VoiceCapture[];
	updates: readonly VoiceUpdate[];
}>;
