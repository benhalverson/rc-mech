import { Service } from '@angular/core';

@Service({ autoProvided: false })
export class CorrectionPlayer {
	showFrame(player: HTMLVideoElement, timestampMs: number): void {
		player.pause();
		player.currentTime = timestampMs / 1000;
	}
}
