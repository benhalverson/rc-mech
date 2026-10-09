import { signal } from '@angular/core';
import { vi } from 'vitest';
import type {
	SettingsOperation,
	SettingsSnapshot,
} from './settings-sync.models';
import type { SettingsMutationOutcome } from './settings-workspace-store';
/**
 * In-memory Settings coordinator double for route/component specs. Exposes the
 * signals and command spies those consumers use without opening IndexedDB or
 * calling HTTP; durable behavior is tested at the storage/coordinator boundary.
 */
export class FakeSettingsWorkspace {
	readonly available = signal(false);
	readonly current = signal<SettingsSnapshot | null>(null);
	readonly operations = signal<readonly SettingsOperation[]>([]);
	readonly outcome = signal<SettingsMutationOutcome>({
		status: 'idle',
		requestId: null,
	});
	readonly mutate = vi.fn();
}
