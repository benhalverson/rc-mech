import { Component, inject } from '@angular/core';
import { DrivingAnalysisFlagStore } from './driving-analysis-flag-store';

/**
 * Renders the Owner's Driving analysis toggle and save feedback. Sends the explicit
 * enabled intent to DrivingAnalysisFlagStore; authorization and asynchronous save
 * outcomes remain in the workflow rather than the toggle component.
 */
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
