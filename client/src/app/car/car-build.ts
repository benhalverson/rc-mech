import { DatePipe } from '@angular/common';
import { HttpClient, httpResource } from '@angular/common/http';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

export type InstalledComponent = {
	id: string;
	carId: string;
	slot: string;
	slotType?: 'standard' | 'custom' | null;
	name: string;
	manufacturer?: string | null;
	model?: string | null;
	serialNumber?: string | null;
	notes?: string | null;
	installedAt?: string;
	removedAt?: string | null;
};

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

const installationTime = (component: InstalledComponent): number => {
	const timestamp = component.installedAt
		? Date.parse(component.installedAt)
		: Number.NaN;
	return Number.isNaN(timestamp) ? 0 : timestamp;
};

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
	imports: [CarSectionShell, DatePipe, FormsModule],
	template: `
		@if (carStore.loading()) { <div class="state-card" role="status">Opening the car record…</div> }
		@else if (carStore.error()) { <div class="state-card" role="alert"><p>{{ carStore.error() }}</p>@if (!carStore.notFound()) { <button type="button" (click)="carStore.retry()">Try again</button> }</div> }
		@else if (carStore.car(); as car) {
			<app-car-section-shell [car]="car" section="build">
				<section class="build-sheet" aria-labelledby="build-title">
					<div class="section-heading"><div><div class="eyebrow">Installed components</div><h3 id="build-title">Build sheet</h3></div>@if (!car.archivedAt && !editing()) { <button class="button" type="button" (click)="openAdd()">Add component</button> }</div>
					<p class="section-intro">One current installation per slot. Replacements retain the previous installation as immutable history.</p>
					@if (editing()) {
						<form (ngSubmit)="save()" aria-labelledby="component-form-title"><h4 id="component-form-title">{{ mode() === 'replace' ? 'Fit the replacement' : mode() === 'edit' ? 'Edit installation' : 'Add component' }}</h4>
							@if (formError()) { <p role="alert">{{ formError() }}</p> }
							<div class="form-grid"><label>Slot type <select name="slot-type" [disabled]="mode() === 'edit'" [ngModel]="form().slotType" (ngModelChange)="update('slotType', $event)"><option value="standard">Standard</option><option value="custom">Custom</option></select></label>
							@if (form().slotType === 'standard') { <label>Slot <select name="slot" [disabled]="mode() === 'edit'" [ngModel]="form().slot" (ngModelChange)="update('slot', $event)">@for (slot of standardSlots; track slot) { <option [value]="slot">{{ slot }}</option> }</select></label> }
							@else { <label>Custom slot <input name="slot" required [disabled]="mode() === 'edit'" [ngModel]="form().slot" (ngModelChange)="update('slot', $event)" /></label> }
							<label>Name <input name="name" required maxlength="160" [ngModel]="form().name" (ngModelChange)="update('name', $event)" /></label><label>Manufacturer <input name="manufacturer" [ngModel]="form().manufacturer" (ngModelChange)="update('manufacturer', $event)" /></label><label>Model <input name="model" [ngModel]="form().model" (ngModelChange)="update('model', $event)" /></label><label>Serial number <input name="serial" [ngModel]="form().serialNumber" (ngModelChange)="update('serialNumber', $event)" /></label><label class="wide">Notes <textarea name="notes" rows="3" [ngModel]="form().notes" (ngModelChange)="update('notes', $event)"></textarea></label></div>
							<div class="form-actions"><button class="button" type="submit" [disabled]="action() !== null">Save component</button><button class="button quiet" type="button" (click)="cancel()" [disabled]="action() !== null">Cancel</button></div>
						</form>
					} @else if (resource.isLoading()) { <div class="state-card" role="status">Reading the build sheet…</div> }
					@else if (resource.error()) { <div class="state-card" role="alert"><p>The build sheet could not be loaded.</p><button type="button" (click)="resource.reload()">Try again</button></div> }
					@else if (!groups().length) { <div class="state-card"><h4>No components recorded</h4>@if (!car.archivedAt) { <button type="button" (click)="openAdd()">Add the first component</button> }</div> }
					@else { <div class="component-groups">@for (group of groups(); track group.slot) { <article class="component-slot"><div class="section-heading"><h4>{{ group.slot }}</h4>@if (!car.archivedAt) { <button type="button" (click)="openAdd(group.slot)">{{ group.current ? 'Replace' : 'Install' }}</button> }</div>
						@if (group.current; as current) { <p><strong>{{ current.name }}</strong> · {{ current.manufacturer || 'Manufacturer not recorded' }}@if (current.model) { · {{ current.model }} }</p>@if (!car.archivedAt) { <div class="form-actions"><button type="button" (click)="openEdit(current)">Edit</button><button type="button" (click)="openReplace(current)">Replace</button></div> } }
						@if (group.history.length) { <details><summary>Previous installations ({{ group.history.length }})</summary><ul>@for (old of group.history; track old.id) { <li>{{ old.name }} · removed {{ old.removedAt | date:'mediumDate' }}</li> }</ul></details> }
					</article> }</div> }
					@if (message()) { <p role="status">{{ message() }}</p> }
				</section>
			</app-car-section-shell>
		}
	`,
	styleUrl: '../garage-pages.css',
})
export class CarBuild {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	private readonly http = inject(HttpClient);
	protected readonly standardSlots = standardSlots;
	protected readonly resource = httpResource<{
		components: InstalledComponent[];
	}>(() => {
		const carId = this.carId();
		return carId
			? {
					url: `/api/v1/cars/${encodeURIComponent(carId)}/components`,
					withCredentials: true,
					params: { history: 'true' },
				}
			: undefined;
	});
	protected readonly components = computed(() =>
		this.resource.hasValue() ? this.resource.value().components : [],
	);
	protected readonly groups = computed(() => {
		const grouped = new Map<string, InstalledComponent[]>();
		for (const component of this.components())
			grouped.set(component.slot, [
				...(grouped.get(component.slot) ?? []),
				component,
			]);
		return [...grouped.entries()].map(([slot, items]) => {
			const newestFirst = [...items].sort(
				(left, right) => installationTime(right) - installationTime(left),
			);
			return {
				slot,
				current: newestFirst.find((item) => !item.removedAt) ?? null,
				history: newestFirst.filter((item) => item.removedAt),
			};
		});
	});
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly mode = signal<ComponentMode>('add');
	protected readonly action = signal<ComponentMode | null>(null);
	protected readonly form = signal(emptyForm());
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
		});
	}

	private resetRouteState(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.mode.set('add');
		this.action.set(null);
		this.form.set(emptyForm());
		this.formError.set('');
		this.message.set('');
	}

	protected openAdd(slot = ''): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		const current = slot
			? (this.groups().find((group) => group.slot === slot)?.current ??
				undefined)
			: undefined;
		if (current) {
			this.openReplace(current);
			return;
		}
		this.mode.set('add');
		this.editingId.set(null);
		this.form.set({
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
		this.form.set({
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
		this.form.set({
			...emptyForm(),
			slotType: componentSlotType(component),
			slot: component.slot,
		});
		this.editing.set(true);
	}

	protected update(field: keyof ComponentForm, value: string): void {
		this.form.update((form) => ({ ...form, [field]: value }));
	}

	protected cancel(): void {
		if (this.action()) return;
		this.editing.set(false);
		this.formError.set('');
	}

	protected save(): void {
		if (this.action()) return;
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.formError.set('Restore this car before changing its build.');
			return;
		}
		if (!form.slot.trim() || !form.name.trim()) {
			this.formError.set('Choose a slot and name the component.');
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
				this.resource.reload();
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
					error.status === 409
						? 'Restore this car before changing its build.'
						: 'The component could not be saved.',
				);
			},
		});
	}
}
