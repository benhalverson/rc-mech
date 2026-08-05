import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
	ChangeDetectionStrategy,
	Component,
	Input,
	inject,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';

export type ConsumableCar = {
	id: string;
	name: string;
	archivedAt?: string | null;
};
export type FluidArea =
	| 'front-shocks'
	| 'rear-shocks'
	| 'front-differential'
	| 'rear-differential'
	| 'custom';
export type TireAxle = 'front' | 'rear' | 'both';
export type ConsumableEntry = {
	id: string;
	carId: string;
	kind: 'shock-fluid' | 'differential-fluid' | 'tires';
	performedAt: string;
	fluidArea?: FluidArea | null;
	customArea?: string | null;
	axle?: TireAxle | null;
	frontDetails?: string | null;
	rearDetails?: string | null;
	frontCost?: number | null;
	rearCost?: number | null;
	notes?: string | null;
	deletedAt?: string | null;
};
type MaintenanceResponse = {
	consumableMaintenance?: ConsumableEntry[];
	entries?: ConsumableEntry[];
};
type EntryResponse = { consumableMaintenance: ConsumableEntry };
type SetupResponse = {
	setup?: { tires?: Record<string, unknown> | null };
	setups?: Array<{ current?: boolean; tires?: Record<string, unknown> | null }>;
};
type EntryForm = {
	carId: string;
	kind: 'shock-fluid' | 'differential-fluid' | 'tires';
	performedAt: string;
	fluidArea: FluidArea;
	customArea: string;
	axle: TireAxle;
	frontDetails: string;
	rearDetails: string;
	frontCost: string;
	rearCost: string;
	notes: string;
};

const emptyForm = (): EntryForm => ({
	carId: '',
	kind: 'shock-fluid',
	performedAt: '',
	fluidArea: 'front-shocks',
	customArea: '',
	axle: 'front',
	frontDetails: '',
	rearDetails: '',
	frontCost: '',
	rearCost: '',
	notes: '',
});

@Component({
	selector: 'app-consumable-maintenance',
	standalone: true,
	imports: [CommonModule, DatePipe, FormsModule],
	templateUrl: './consumable-maintenance.html',
	styleUrl: './consumable-maintenance.css',
	changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ConsumableMaintenance {
	private readonly http = inject(HttpClient);
	@Input() set enabled(value: boolean) {
		this.isEnabled = value;
		if (value && this.garage().length && !this.loaded()) this.load();
	}
	@Input() set cars(value: ConsumableCar[]) {
		this.garage.set(value);
		if (this.isEnabled && !this.loaded() && value.length) this.load();
	}
	@Input() timezone = 'UTC';

	protected readonly garage = signal<ConsumableCar[]>([]);
	protected readonly entries = signal<ConsumableEntry[]>([]);
	protected readonly state = signal<'idle' | 'loading' | 'ready' | 'error'>(
		'idle',
	);
	protected readonly error = signal('');
	protected readonly formError = signal('');
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
	protected readonly historyFilter = signal<'active' | 'archived'>('active');
	protected readonly form = signal<EntryForm>(emptyForm());
	protected readonly loaded = signal(false);
	private isEnabled = false;

	protected load(): void {
		this.state.set('loading');
		this.error.set('');
		const requests = this.garage().map((car) =>
			this.http.get<MaintenanceResponse>(this.path(car.id), {
				withCredentials: true,
				params: { history: 'true' },
			}),
		);
		if (!requests.length) {
			this.state.set('ready');
			return;
		}
		let remaining = requests.length;
		const values: ConsumableEntry[] = [];
		let failed = false;
		for (const request of requests) {
			request.subscribe({
				next: (response) => {
					values.push(
						...(response.consumableMaintenance ?? response.entries ?? []),
					);
					if (!--remaining && !failed) this.finishLoad(values);
				},
				error: () => {
					failed = true;
					this.state.set('error');
					this.error.set('Consumable history could not be loaded.');
				},
			});
		}
	}

	private finishLoad(values: ConsumableEntry[]): void {
		this.entries.set(
			values.sort((a, b) => b.performedAt.localeCompare(a.performedAt)),
		);
		this.state.set('ready');
		this.loaded.set(true);
	}
	protected visibleEntries(): ConsumableEntry[] {
		return this.entries().filter((entry) =>
			this.historyFilter() === 'archived'
				? Boolean(entry.deletedAt)
				: !entry.deletedAt,
		);
	}
	protected openCreate(): void {
		const car = this.garage().find((item) => !item.archivedAt);
		this.form.set({
			...emptyForm(),
			carId: car?.id ?? '',
			performedAt: this.localDateTime(new Date()),
		});
		this.editingId.set(null);
		this.formError.set('');
		this.editing.set(true);
	}
	protected openEdit(entry: ConsumableEntry): void {
		if (this.isReadOnly(entry)) return;
		this.form.set({
			...emptyForm(),
			carId: entry.carId,
			kind: entry.kind,
			performedAt: this.localDateTime(new Date(entry.performedAt)),
			fluidArea: entry.fluidArea ?? 'front-shocks',
			customArea: entry.customArea ?? '',
			axle: entry.axle ?? 'front',
			frontDetails: entry.frontDetails ?? '',
			rearDetails: entry.rearDetails ?? '',
			frontCost: entry.frontCost == null ? '' : String(entry.frontCost),
			rearCost: entry.rearCost == null ? '' : String(entry.rearCost),
			notes: entry.notes ?? '',
		});
		this.editingId.set(entry.id);
		this.formError.set('');
		this.editing.set(true);
	}
	protected cancelEdit(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.formError.set('');
	}
	protected update(field: keyof EntryForm, value: string): void {
		this.form.update((current) => ({ ...current, [field]: value }));
		if (field === 'kind' && value !== 'tires')
			this.form.update((current) => ({ ...current, axle: 'front' }));
		if (field === 'kind' && value === 'tires')
			this.prefillTires(this.form().carId);
	}
	protected save(): void {
		const form = this.form();
		if (!form.carId || !form.performedAt) {
			this.formError.set('Choose a car and date for this entry.');
			return;
		}
		if (
			form.kind === 'tires' &&
			form.axle === 'both' &&
			!form.frontDetails.trim() &&
			!form.rearDetails.trim()
		) {
			this.formError.set('Add front or rear tire details before saving.');
			return;
		}
		const frontCost = this.optionalCost(form.frontCost);
		const rearCost = this.optionalCost(form.rearCost);
		if (frontCost === 'invalid' || rearCost === 'invalid') {
			this.formError.set('Costs must be zero or greater.');
			return;
		}
		if (this.action()) return;
		const payload =
			form.kind === 'tires'
				? {
						kind: form.kind,
						performedAt: this.toIso(form.performedAt),
						axle: form.axle,
						...(form.axle !== 'rear' && form.frontDetails.trim()
							? { frontDetails: form.frontDetails.trim() }
							: {}),
						...(form.axle !== 'rear' && frontCost !== null
							? { frontCost }
							: {}),
						...(form.axle !== 'front' && form.rearDetails.trim()
							? { rearDetails: form.rearDetails.trim() }
							: {}),
						...(form.axle !== 'front' && rearCost !== null ? { rearCost } : {}),
						...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
					}
				: {
						kind: form.kind,
						performedAt: this.toIso(form.performedAt),
						fluidArea: form.fluidArea,
						...(form.fluidArea === 'custom' && form.customArea.trim()
							? { customArea: form.customArea.trim() }
							: {}),
						...(frontCost !== null ? { cost: frontCost } : {}),
						...(form.notes.trim() ? { notes: form.notes.trim() } : {}),
					};
		const id = this.editingId();
		this.action.set(id ? 'edit' : 'create');
		this.formError.set('');
		const request = id
			? this.http.patch<EntryResponse>(
					`${this.path(form.carId)}/${id}`,
					payload,
					{ withCredentials: true },
				)
			: this.http.post<EntryResponse>(this.path(form.carId), payload, {
					withCredentials: true,
				});
		request.subscribe({
			next: ({ consumableMaintenance }) => {
				this.entries.update((items) =>
					id
						? items.map((item) =>
								item.id === id ? consumableMaintenance : item,
							)
						: [consumableMaintenance, ...items],
				);
				this.action.set(null);
				this.cancelEdit();
			},
			error: (error: { status?: number }) => {
				this.action.set(null);
				this.formError.set(
					error.status === 409
						? 'This car is archived. Restore it before recording maintenance.'
						: 'The consumable entry could not be saved.',
				);
			},
		});
	}
	protected archive(entry: ConsumableEntry): void {
		if (this.isReadOnly(entry) || this.action()) return;
		this.action.set(`archive:${entry.id}`);
		this.http
			.delete<EntryResponse>(`${this.path(entry.carId)}/${entry.id}`, {
				withCredentials: true,
			})
			.subscribe({
				next: ({ consumableMaintenance }) => {
					this.replace(consumableMaintenance);
					this.action.set(null);
				},
				error: () => {
					this.action.set(null);
					this.error.set('That consumable entry could not be archived.');
				},
			});
	}
	protected restore(entry: ConsumableEntry): void {
		if (this.action()) return;
		this.action.set(`restore:${entry.id}`);
		this.http
			.post<EntryResponse>(
				`${this.path(entry.carId)}/${entry.id}/restore`,
				{},
				{ withCredentials: true },
			)
			.subscribe({
				next: ({ consumableMaintenance }) => {
					this.replace(consumableMaintenance);
					this.action.set(null);
				},
				error: () => {
					this.action.set(null);
					this.error.set('That consumable entry could not be restored.');
				},
			});
	}
	protected isReadOnly(entry: ConsumableEntry): boolean {
		return (
			Boolean(
				this.garage().find((car) => car.id === entry.carId)?.archivedAt,
			) || Boolean(entry.deletedAt)
		);
	}
	protected carName(carId: string): string {
		return this.garage().find((car) => car.id === carId)?.name ?? 'Unknown car';
	}
	protected kindLabel(kind: ConsumableEntry['kind']): string {
		return kind === 'tires'
			? 'Tire set'
			: kind === 'shock-fluid'
				? 'Shock fluid'
				: 'Differential fluid';
	}
	protected areaLabel(entry: ConsumableEntry): string {
		return entry.kind === 'tires'
			? `${entry.axle ?? 'front'} axle`
			: entry.fluidArea === 'custom'
				? entry.customArea || 'Custom area'
				: (entry.fluidArea ?? '').replaceAll('-', ' ');
	}
	protected entryCost(entry: ConsumableEntry): string {
		const total = (entry.frontCost ?? 0) + (entry.rearCost ?? 0);
		return total ? `$${total.toFixed(2)}` : 'No cost logged';
	}
	protected setHistoryFilter(value: 'active' | 'archived'): void {
		this.historyFilter.set(value);
	}
	private replace(entry: ConsumableEntry): void {
		this.entries.update((items) =>
			items.map((item) => (item.id === entry.id ? entry : item)),
		);
	}
	private path(carId: string): string {
		return `/api/v1/cars/${carId}/consumable-maintenance`;
	}
	private optionalCost(value: string): number | null | 'invalid' {
		if (!value.trim()) return null;
		const number = Number(value);
		return Number.isFinite(number) && number >= 0 ? number : 'invalid';
	}
	private prefillTires(carId: string): void {
		if (!carId) return;
		this.http
			.get<SetupResponse>(`/api/v1/cars/${carId}/setups/current`, {
				withCredentials: true,
			})
			.subscribe({
				next: (response) => {
					const setup =
						response.setup ??
						response.setups?.find((item) => item.current) ??
						response.setups?.[0];
					if (!setup?.tires) return;
					const details = Object.entries(setup.tires)
						.map(([key, value]) => `${key}: ${String(value)}`)
						.join('\n');
					this.form.update((current) => ({
						...current,
						frontDetails: current.frontDetails || details,
						rearDetails: current.rearDetails || details,
					}));
				},
			});
	}
	private localDateTime(date: Date): string {
		return new Intl.DateTimeFormat('en-CA', {
			timeZone: this.timezone,
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		})
			.format(date)
			.replace(' ', 'T');
	}
	private toIso(value: string): string {
		return new Date(value).toISOString();
	}
}
