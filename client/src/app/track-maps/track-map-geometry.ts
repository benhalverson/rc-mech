import { Component, input } from '@angular/core';
import type { Point, TrackCorner } from './track-map.models';

@Component({
	selector: 'app-track-map-geometry',
	host: { class: 'block' },
	templateUrl: './track-map-geometry.html',
})
export class TrackMapGeometry {
	readonly corners = input.required<readonly TrackCorner[]>();
	readonly activeCorner = input<TrackCorner | null>(null);
	readonly decorative = input(false);
	readonly overlay = input(false);
	readonly label = input.required<string>();

	protected svgX(point: Point): number {
		return point.x * 640;
	}
	protected svgY(point: Point): number {
		return point.y * 360;
	}
}
