import { Component, effect, inject, input } from '@angular/core';
import { CarSectionShell } from '../car/car-section-shell';
import { CarStore } from '../car/car-store';
import { VoiceNoteWorkspace } from './voice-note-workspace';

@Component({
	selector: 'app-voice-track-log',
	imports: [CarSectionShell, VoiceNoteWorkspace],
	templateUrl: './voice-track-log.html',
})
export class VoiceTrackLog {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (carId) this.carStore.selectCar(carId);
		});
	}
}
