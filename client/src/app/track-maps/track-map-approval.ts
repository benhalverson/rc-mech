import { Component, computed, input, output } from '@angular/core';
import type { TrackCorner, TrackMapVersion } from './track-map.models';

@Component({
	selector: 'app-track-map-approval',
	host: { class: 'grid gap-2' },
	templateUrl: './track-map-approval.html',
})
export class TrackMapApproval {
	readonly version = input<TrackMapVersion | null>(null);
	readonly corners = input<readonly TrackCorner[]>([]);
	readonly busy = input(false);
	readonly valid = input(true);
	readonly approveRequested = output<void>();
	protected readonly dirty = computed(
		() =>
			JSON.stringify(this.corners()) !==
			JSON.stringify(this.version()?.corners ?? []),
	);
	protected readonly canApprove = computed(
		() =>
			this.version()?.status === 'draft' &&
			this.version()?.referenceFrame !== null &&
			this.corners().length > 0 &&
			this.valid() &&
			!this.dirty(),
	);

	protected approve(): void {
		this.approveRequested.emit();
	}
}
