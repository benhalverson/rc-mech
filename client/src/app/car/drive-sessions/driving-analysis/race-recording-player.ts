import { Component, input } from '@angular/core';
import type { RaceRecording } from './race-recording.models';

@Component({
	selector: 'app-race-recording-player',
	templateUrl: './race-recording-player.html',
})
export class RaceRecordingPlayer {
	readonly recording = input.required<RaceRecording>();
}
