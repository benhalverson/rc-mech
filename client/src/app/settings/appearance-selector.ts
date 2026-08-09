import { Component, inject } from '@angular/core';
import {
	LucideMonitor,
	LucideMoon,
	LucideSun,
	LucideTriangleAlert,
} from '@lucide/angular';
import {
	AppearanceService,
	type AppearancePreference,
} from '../appearance.service';

@Component({
	selector: 'app-appearance-selector',
	host: { class: 'block min-w-0 w-full max-w-full' },
	imports: [LucideMonitor, LucideMoon, LucideSun, LucideTriangleAlert],
	templateUrl: './appearance-selector.html',
})
export class AppearanceSelector {
	protected readonly appearance = inject(AppearanceService);

	protected setAppearance(preference: AppearancePreference): void {
		this.appearance.setAppearance(preference);
	}
}
