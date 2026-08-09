import { Component, computed, inject, signal } from '@angular/core';
import {
	LucidePlus,
	LucideRefreshCw,
	LucideTriangleAlert,
} from '@lucide/angular';
import type { ConsumableEntry } from '../maintenance.models';
import {
	consumableEntryIsReadOnly,
	visibleConsumableEntries,
} from './consumable.rules';
import {
	ConsumableEntryEditor,
	type ConsumableEntryEditorRequest,
} from './consumable-entry-editor';
import { ConsumableHistory } from './consumable-history';
import { ConsumableStore } from './consumable-store';

export type { ConsumableEntry } from '../maintenance.models';

@Component({
	selector: 'app-consumable-maintenance',
	imports: [
		ConsumableEntryEditor,
		ConsumableHistory,
		LucidePlus,
		LucideRefreshCw,
		LucideTriangleAlert,
	],
	templateUrl: './consumable-maintenance.html',
	host: { class: 'block' },
})
export class ConsumableMaintenance {
	private readonly store = inject(ConsumableStore);

	protected readonly activeRequest =
		signal<ConsumableEntryEditorRequest | null>(null);
	protected readonly historyFilter = signal<'active' | 'archived'>('active');
	protected readonly state = computed(() =>
		this.store.loading() ? 'loading' : this.store.error() ? 'error' : 'ready',
	);
	protected readonly error = this.store.error;
	protected readonly action = this.store.action;
	protected readonly hasActiveCars = computed(() =>
		this.store.cars().some((car) => !car.archivedAt),
	);
	protected readonly hasVisibleEntries = computed(
		() =>
			visibleConsumableEntries(this.store.entries(), this.historyFilter())
				.length > 0,
	);

	protected createEntry(): void {
		if (!this.hasActiveCars() || this.action()) return;
		this.activeRequest.set({ kind: 'create' });
	}

	protected editEntry(entry: ConsumableEntry): void {
		if (this.action() || consumableEntryIsReadOnly(entry, this.store.cars()))
			return;
		this.activeRequest.set({ kind: 'edit', entry });
	}

	protected closeEditor(): void {
		this.activeRequest.set(null);
	}

	protected load(): void {
		this.store.clearOutcome();
		this.store.retry();
	}
}
