import { Service } from '@angular/core';

@Service()
export class CorrectionPlayer {
	showFrame(player: HTMLVideoElement, timestampMs: number): void {
		player.pause();
		player.currentTime = timestampMs / 1000;
	}
}
