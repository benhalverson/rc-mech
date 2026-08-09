import { Component, inject } from '@angular/core';
import { LucideMonitor, LucideMoon, LucideSun } from '@lucide/angular';
import {
	AppearanceService,
	type AppearancePreference,
} from '../appearance.service';

@Component({
	selector: 'app-appearance-selector',
	imports: [LucideMonitor, LucideMoon, LucideSun],
	templateUrl: './appearance-selector.html',
})
export class AppearanceSelector {
	protected readonly appearance = inject(AppearanceService);

	protected setAppearance(preference: AppearancePreference): void {
		this.appearance.setAppearance(preference);
	}
}
