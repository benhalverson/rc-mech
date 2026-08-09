import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, signal } from '@angular/core';
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
import type { InstalledComponent } from './car.models';
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

type ComponentMode = 'add' | 'edit' | 'replace';

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
	private readonly http = inject(HttpClient);
	protected readonly standardSlots = standardSlots;
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly mode = signal<ComponentMode>('add');
	protected readonly action = signal<ComponentMode | null>(null);
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
	protected readonly formError = signal('');
	protected readonly message = signal('');

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
			this.carStore.selectCar(carId);
			this.buildStore.selectCar(carId);
		});
	}

	private resetRouteState(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.mode.set('add');
		this.action.set(null);
		this.componentForm().reset(emptyForm());
		this.formError.set('');
		this.message.set('');
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
		this.formError.set('');
		this.componentForm().reset();
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		if (this.action()) return;
		this.formError.set('');
		this.message.set('');
		this.componentForm().markAsTouched();
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.formError.set('Restore this car before changing its build.');
			return;
		}
		if (this.componentForm().invalid()) {
			this.formError.set('Review the highlighted component fields.');
			if (this.componentForm.slot().invalid())
				this.componentForm.slot().focusBoundControl();
			else this.componentForm.name().focusBoundControl();
			return;
		}
		const mode = this.mode();
		const id = this.editingId();
		this.action.set(mode);
		const request =
			mode === 'edit' && id
				? this.http.patch(
						`/api/v1/cars/${encodeURIComponent(car.id)}/components/${encodeURIComponent(id)}`,
						payload(form, false),
						{ withCredentials: true },
					)
				: mode === 'replace' && id
					? this.http.post(
							`/api/v1/cars/${encodeURIComponent(car.id)}/components/${encodeURIComponent(id)}/replace`,
							payload(form),
							{ withCredentials: true },
						)
					: this.http.post(
							`/api/v1/cars/${encodeURIComponent(car.id)}/components`,
							payload(form),
							{ withCredentials: true },
						);
		request.subscribe({
			next: () => {
				if (this.carId() !== car.id) return;
				this.buildStore.refresh();
				this.action.set(null);
				this.editing.set(false);
				this.message.set(
					mode === 'replace'
						? 'Component replaced; previous installation retained.'
						: 'Build sheet saved.',
				);
			},
			error: (error: { status?: number }) => {
				if (this.carId() !== car.id) return;
				this.action.set(null);
				this.formError.set(
					error.status === 401
						? 'Your garage session has expired. Sign in again to continue.'
						: error.status === 409
							? 'Restore this car before changing its build.'
							: 'The component could not be saved.',
				);
			},
		});
	}
}
