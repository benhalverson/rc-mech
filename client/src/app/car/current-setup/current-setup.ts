import { DatePipe } from '@angular/common';
import { Component, inject, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrentSetupStore } from './current-setup-store';

@Component({
	selector: 'app-current-setup',
	imports: [DatePipe, RouterLink],
	templateUrl: './current-setup.html',
	host: { class: 'block' },
})
export class CurrentSetup {
	readonly carId = input.required<string>();
	readonly archived = input(false);
	protected readonly store = inject(CurrentSetupStore);

	protected setupRoute(): string[] {
		return ['/garage', this.carId(), 'setups'];
	}
}
