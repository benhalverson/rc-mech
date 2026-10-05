import { Component, input, linkedSignal } from '@angular/core';
import type { CornerClipArtifact } from './corner-clip.models';

@Component({ selector: 'app-corner-clip', templateUrl: './corner-clip.html' })
export class CornerClip {
	readonly clip = input<CornerClipArtifact | null>(null);
	readonly label = input.required<string>();
	readonly contentUrl = input<string | null>(null);
	protected readonly failed = linkedSignal({
		source: () => this.contentUrl(),
		computation: () => false,
	});
}
