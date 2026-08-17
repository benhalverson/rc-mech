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

	protected chooseLayout(layoutId: string): void {
		this.store.selectLayout(layoutId);
		const layout = this.store.layouts().find((item) => item.id === layoutId);
		this.layoutName.set(layout?.name ?? '');
		const version = layout?.mapVersions.find((item) => item.status === 'draft');
		if (version) this.store.loadVersion(version.id);
	}
	protected createLayout(): void {
		const name = this.newLayoutName().trim();
		if (name) {
			this.store.createLayout(name);
			this.newLayoutName.set('');
		}
	}
	protected createDraft(): void {
		const layout = this.selectedLayout();
		if (layout)
			this.store.createDraft(
				layout.id,
				layout.mapVersions.find((version) => version.status === 'approved')?.id,
			);
	}
	protected renameLayout(): void {
		const name = this.layoutName().trim();
		if (name) this.store.renameLayout(name);
	}
	protected setNewLayoutName(event: Event): void {
		if (event.target instanceof HTMLInputElement)
			this.newLayoutName.set(event.target.value);
	}
	protected setLayoutName(event: Event): void {
		if (event.target instanceof HTMLInputElement)
			this.layoutName.set(event.target.value);
	}
}
