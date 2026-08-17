import { Component, input } from '@angular/core';
import type { Point, TrackMapVersion } from './track-map.models';
import { TrackMapGeometry } from './track-map-geometry';

@Component({
	selector: 'app-track-map-review',
	host: { class: 'block' },
	imports: [TrackMapGeometry],
	templateUrl: './track-map-review.html',
})
export class TrackMapReview {
	readonly version = input.required<TrackMapVersion>();

	protected pointLabel(point: Point): string {
		return `${point.x}, ${point.y}`;
	}
}
