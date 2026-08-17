import { Component, inject, linkedSignal, signal } from '@angular/core';
import type { TrackLayout } from './track-map.models';
import { TrackMapEditor } from './track-map-editor';
import { TrackMapStore } from './track-map-store';

@Component({
	selector: 'app-track-maps',
	imports: [TrackMapEditor],
	templateUrl: './track-maps.html',
})
export class TrackMaps {
	protected readonly store = inject(TrackMapStore);
	protected readonly newLayoutName = signal('');
	protected readonly layoutName = signal('');
	protected readonly selectedLayout = linkedSignal<
		{
			layouts: TrackLayout[];
			selectedLayoutId: string | null;
		},
		TrackLayout | null
	>({
		source: () => ({
			layouts: this.store.layouts(),
			selectedLayoutId: this.store.selectedLayoutId(),
		}),
		computation: ({ layouts, selectedLayoutId }, previous) =>
			layouts.find((layout) => layout.id === selectedLayoutId) ??
			(selectedLayoutId && previous?.value?.id === selectedLayoutId
				? previous.value
				: null),
	});

	protected chooseLayout(layout: TrackLayout): void {
		this.layoutName.set(layout.name);
		this.store.openLayout(layout.id);
	}
	protected createLayout(): void {
		const name = this.newLayoutName().trim();
		if (name) {
			this.store.createLayout({ name });
			this.newLayoutName.set('');
		}
	}
	protected createDraft(layout: TrackLayout): void {
		this.store.createDraft({
			layoutId: layout.id,
			sourceVersionId: layout.mapVersions.find(
				(version) => version.status === 'approved',
			)?.id,
		});
	}
	protected renameLayout(): void {
		const name = this.layoutName().trim();
		if (name) this.store.renameLayout({ name });
	}
	protected setNewLayoutName(value: string): void {
		this.newLayoutName.set(value);
	}
	protected setLayoutName(value: string): void {
		this.layoutName.set(value);
	}
}
