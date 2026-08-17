import { Component, input } from '@angular/core';
import type { Point, TrackMapVersion } from './track-map.models';

@Component({
	selector: 'app-track-map-review',
	host: { class: 'block' },
	templateUrl: './track-map-review.html',
})
export class TrackMapReview {
	readonly version = input.required<TrackMapVersion>();

	protected svgX(point: Point): number {
		return point.x * 640;
	}
	protected svgY(point: Point): number {
		return point.y * 360;
	}
	protected pointLabel(point: Point): string {
		return `${point.x}, ${point.y}`;
	}
}
