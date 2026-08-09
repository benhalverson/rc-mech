import { DatePipe } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import {
	LucideArchive,
	LucidePencil,
	LucidePlus,
	LucideRefreshCw,
	LucideRepeat2,
	LucideSave,
	LucideTriangleAlert,
	LucideWrench,
} from '@lucide/angular';
import type { BuildMode, InstalledComponent } from './car.models';
import { CarBuildStore } from './car-build-store';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

type ComponentForm = {
	slotType: 'standard' | 'custom';
	slot: string;
	name: string;
	manufacturer: string;
	model: string;
	serialNumber: string;
	notes: string;
};

const standardSlots = [
	'motor',
	'esc',
	'battery',
	'steering-servo',
	'throttle-servo',
	'receiver',
	'gyro',
	'transmitter',
	'tires',
	'wheels',
	'shocks',
	'front-differential',
	'center-differential',
	'rear-differential',
	'slipper-clutch',
	'pinion-gear',
	'spur-gear',
	'body',
	'wing',
];

const componentSlotType = (
	component: InstalledComponent,
): ComponentForm['slotType'] =>
	component.slotType ??
	(standardSlots.includes(component.slot) ? 'standard' : 'custom');

const emptyForm = (): ComponentForm => ({
	slotType: 'standard',
	slot: 'motor',
	name: '',
	manufacturer: '',
	model: '',
	serialNumber: '',
	notes: '',
});

const payload = (form: ComponentForm, includeSlot = true) => ({
	...(includeSlot ? { slotType: form.slotType, slot: form.slot.trim() } : {}),
	name: form.name.trim(),
	...(form.manufacturer.trim()
		? { manufacturer: form.manufacturer.trim() }
		: {}),
	...(form.model.trim() ? { model: form.model.trim() } : {}),
	...(form.serialNumber.trim()
		? { serialNumber: form.serialNumber.trim() }
		: {}),
	...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
});

@Component({
	selector: 'app-car-build',
	host: { class: 'block' },
	imports: [
		CarSectionShell,
		DatePipe,
		FormField,
		LucideArchive,
		LucidePencil,
		LucidePlus,
		LucideRefreshCw,
		LucideRepeat2,
		LucideSave,
		LucideTriangleAlert,
		LucideWrench,
	],
	templateUrl: './car-build.html',
})
export class CarBuild {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	protected readonly buildStore = inject(CarBuildStore);
	protected readonly standardSlots = standardSlots;
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly mode = signal<BuildMode>('add');
	protected readonly action = this.buildStore.action;
	protected readonly form = signal(emptyForm());
	protected readonly componentForm = signalForm(this.form, (path) => {
		required(path.slot, { message: 'Choose a component slot.' });
		required(path.name, { message: 'Name the component.' });
		validate(path.slot, ({ value }) =>
			!value() || value().trim()
				? undefined
				: { kind: 'blankSlot', message: 'Choose a component slot.' },
		);
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: { kind: 'blankName', message: 'Name the component.' },
		);
		maxLength(path.name, 160, {
			message: 'Use 160 characters or fewer for the component name.',
		});
	});
	private readonly validationError = signal('');
	protected readonly formError = computed(
		() => this.validationError() || this.buildStore.error(),
	);
	protected readonly message = this.buildStore.message;

	constructor() {
		let previousCarId: string | undefined;
		let handledOperationId: number | null = null;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
			this.carStore.selectCar(carId);
			this.buildStore.selectCar(carId);
		});
		effect(() => {
			const outcome = this.buildStore.outcome();
			if (
				outcome.status !== 'succeeded' ||
				outcome.operationId === handledOperationId
			)
				return;
			handledOperationId = outcome.operationId;
			this.editing.set(false);
		});
	}

	private resetRouteState(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.mode.set('add');
		this.buildStore.clearOutcome();
		this.componentForm().reset(emptyForm());
		this.validationError.set('');
	}

	protected openAdd(slot = ''): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		const current = slot
			? (this.buildStore.groups().find((group) => group.slot === slot)
					?.current ?? undefined)
			: undefined;
		if (current) {
			this.openReplace(current);
			return;
		}
		this.mode.set('add');
		this.editingId.set(null);
		this.componentForm().reset({
			...emptyForm(),
			slot: slot || 'motor',
			slotType: slot && !standardSlots.includes(slot) ? 'custom' : 'standard',
		});
		this.editing.set(true);
	}

	protected openEdit(component: InstalledComponent): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		this.mode.set('edit');
		this.editingId.set(component.id);
		this.componentForm().reset({
			slotType: componentSlotType(component),
			slot: component.slot,
			name: component.name,
			manufacturer: component.manufacturer ?? '',
			model: component.model ?? '',
			serialNumber: component.serialNumber ?? '',
			notes: component.notes ?? '',
		});
		this.editing.set(true);
	}

	protected openReplace(component: InstalledComponent): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		this.mode.set('replace');
		this.editingId.set(component.id);
		this.componentForm().reset({
			...emptyForm(),
			slotType: componentSlotType(component),
			slot: component.slot,
		});
		this.editing.set(true);
	}

	protected cancel(): void {
		if (this.action()) return;
		this.editing.set(false);
		this.validationError.set('');
		this.buildStore.clearOutcome();
		this.componentForm().reset();
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		if (this.action()) return;
		this.validationError.set('');
		this.buildStore.clearOutcome();
		this.componentForm().markAsTouched();
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.validationError.set('Restore this car before changing its build.');
			return;
		}
		if (this.componentForm().invalid()) {
			this.validationError.set('Review the highlighted component fields.');
			if (this.componentForm.slot().invalid())
				this.componentForm.slot().focusBoundControl();
			else this.componentForm.name().focusBoundControl();
			return;
		}
		const mode = this.mode();
		const id = this.editingId();
		this.buildStore.save({
			mode,
			componentId: id,
			input: payload(form, mode !== 'edit'),
		});
	}
}
