import { Component, inject } from '@angular/core';
import { DrivingAnalysisFlagStore } from './driving-analysis-flag-store';

@Component({
	selector: 'app-driving-analysis-flag-settings',
	templateUrl: './driving-analysis-flag-settings.html',
})
export class DrivingAnalysisFlagSettings {
	protected readonly store = inject(DrivingAnalysisFlagStore);

	protected save(toggle: HTMLInputElement): void {
		const enabled = toggle.checked;
		toggle.checked = this.store.enabled() === true;
		this.store.save({ enabled });
	}
}
