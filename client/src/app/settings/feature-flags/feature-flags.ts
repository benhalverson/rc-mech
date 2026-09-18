import { Component, inject } from '@angular/core';
import { FeatureFlagStore } from './feature-flag-store';

@Component({
	selector: 'app-feature-flags',
	templateUrl: './feature-flags.html',
})
export class FeatureFlags {
	protected readonly store = inject(FeatureFlagStore);

	protected save(toggle: HTMLInputElement): void {
		const enabled = toggle.checked;
		toggle.checked = this.store.enabled() === true;
		this.store.save({ enabled });
	}
}
