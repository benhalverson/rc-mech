import { NgOptimizedImage } from '@angular/common';
import { Component, signal } from '@angular/core';
import type { TrackCorner } from './track-map.models';
import { TrackMapGeometry } from './track-map-geometry';

const prototypeCorners: readonly TrackCorner[] = [
	{
		key: 'corner-1',
		name: 'Hairpin',
		order: 1,
		entryGate: {
			start: { x: 0.2, y: 0.72 },
			end: { x: 0.34, y: 0.64 },
			direction: 'forward',
		},
		exitGate: {
			start: { x: 0.62, y: 0.32 },
			end: { x: 0.74, y: 0.24 },
			direction: 'forward',
		},
		cornerView: { x: 0.28, y: 0.32, width: 0.3, height: 0.26 },
	},
	{
		key: 'corner-2',
		name: 'Sweep',
		order: 2,
		entryGate: {
			start: { x: 0.76, y: 0.7 },
			end: { x: 0.88, y: 0.62 },
			direction: 'forward',
		},
		exitGate: {
			start: { x: 0.38, y: 0.14 },
			end: { x: 0.5, y: 0.1 },
			direction: 'forward',
		},
		cornerView: { x: 0.55, y: 0.12, width: 0.28, height: 0.24 },
	},
];

@Component({
	selector: 'app-track-map-prototype',
	imports: [NgOptimizedImage, TrackMapGeometry],
	templateUrl: './track-map-prototype.html',
})
export class TrackMapPrototype {
	protected readonly recording = signal('Saturday practice · Main1.mov');
	protected readonly timestamp = signal(184);
	protected readonly activeCorner = signal(0);
	protected readonly target = signal<
		'Entry gate' | 'Exit gate' | 'Corner view'
	>('Entry gate');
	protected readonly corners = prototypeCorners;
	protected readonly recordings = [
		'Saturday practice · Main1.mov',
		'Club race · heat 3.mp4',
	] as const;

	protected setRecording(value: string): void {
		this.recording.set(value);
	}

	protected setTimestamp(value: string): void {
		const parsed = Number(value);
		/* istanbul ignore next -- invalid keyboard input is guarded by the native number control. */
		if (Number.isFinite(parsed)) this.timestamp.set(parsed);
	}

	protected selectCorner(value: string): void {
		const parsed = Number(value);
		if (Number.isInteger(parsed) && parsed >= 0 && parsed < this.corners.length)
			this.activeCorner.set(parsed);
	}

	protected selectTarget(value: string): void {
		if (
			value === 'Entry gate' ||
			value === 'Exit gate' ||
			value === 'Corner view'
		)
			this.target.set(value);
	}
}
