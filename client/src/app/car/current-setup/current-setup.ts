import { DatePipe } from '@angular/common';
import {
	afterNextRender,
	Component,
	effect,
	ElementRef,
	inject,
	Injector,
	input,
	signal,
} from '@angular/core';
import { RouterLink } from '@angular/router';
import { CurrentSetupStore } from './current-setup-store';
import type { CurrentSetupSnapshot } from './current-setup.models';
import { SetupChangeEditor } from './setup-change-editor';
import {
	setupChangeFormFromSnapshot,
	type SetupChangeFormModel,
} from './setup-change.rules';

type SetupChangeSession = {
	readonly setup: CurrentSetupSnapshot;
	readonly form: SetupChangeFormModel;
	readonly focusField: string;
};

@Component({
	selector: 'app-current-setup',
	imports: [DatePipe, RouterLink, SetupChangeEditor],
	templateUrl: './current-setup.html',
	host: { class: 'block' },
})
export class CurrentSetup {
	readonly carId = input.required<string>();
	readonly archived = input(false);
	protected readonly store = inject(CurrentSetupStore);
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly injector = inject(Injector);
	protected readonly changeSession = signal<SetupChangeSession | null>(null);
	protected readonly saveMessage = signal('');
	private returnFocus = 'name';

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && previousCarId !== carId) {
				this.changeSession.set(null);
				this.saveMessage.set('');
			}
			previousCarId = carId;
			this.store.selectCar(carId);
		});
	}

	protected setupRoute(): string[] {
		return ['/garage', this.carId(), 'setups'];
	}

	protected beginChange(focusField: string): void {
		const setup = this.store.current();
		if (
			!setup ||
			this.archived() ||
			this.store.pending() ||
			!this.store.timezoneReady()
		)
			return;
		this.store.clearSaveOutcome();
		this.saveMessage.set('');
		this.returnFocus = focusField;
		this.changeSession.set({
			setup,
			focusField,
			form: setupChangeFormFromSnapshot(
				setup,
				new Date(),
				this.store.timezone(),
			),
		});
	}

	protected cancelChange(): void {
		this.closeChange(false);
	}

	protected completeChange(): void {
		this.closeChange(true);
	}

	private closeChange(saved: boolean): void {
		this.changeSession.set(null);
		this.saveMessage.set(saved ? 'New Current setup saved.' : '');
		afterNextRender(
			() => {
				const controls = this.host.nativeElement.querySelectorAll<HTMLElement>(
					'[data-change-trigger]',
				);
				const target = [...controls].find(
					(control) => control.dataset['changeTrigger'] === this.returnFocus,
				);
				(target ?? controls.item(0))?.focus();
			},
			{ injector: this.injector },
		);
	}
}
