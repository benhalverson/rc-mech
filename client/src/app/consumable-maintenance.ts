import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import {
	Component,
	computed,
	inject,
	linkedSignal,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { MaintenanceStore } from './maintenance/maintenance-store';

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
	cost?: number | null;
	currency?: string | null;
	notes?: string | null;
	deletedAt?: string | null;
};
export type TireReport = {
	front: TireReportAxle;
	rear: TireReportAxle;
	spend: {
		front: number;
		rear: number;
		combined: number;
		missingCostEntries: number;
	};
	fluidEntries: ConsumableEntry[];
};
export type TireReportAxle = {
	latest: ConsumableEntry | null;
	eventCount: number;
	averageDays: number | null;
	missingDetails: boolean;
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

const isTireEntry = (entry: ConsumableEntry): boolean =>
	entry.kind === 'tires' && !entry.deletedAt;

const includesAxle = (
	entry: ConsumableEntry,
	axle: 'front' | 'rear',
): boolean => entry.axle === axle || entry.axle === 'both';

const averageIntervalDays = (entries: ConsumableEntry[]): number | null => {
	if (entries.length < 2) return null;
	let total = 0;
	for (let index = 1; index < entries.length; index += 1) {
		total +=
			(new Date(entries[index - 1].performedAt).getTime() -
				new Date(entries[index].performedAt).getTime()) /
			86400000;
	}
	return Math.round((total / (entries.length - 1)) * 10) / 10;
};

const reportAxle = (
	entries: ConsumableEntry[],
	axle: 'front' | 'rear',
): TireReportAxle => {
	const events = entries
		.filter((entry) => includesAxle(entry, axle))
		.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
	return {
		latest: events[0] ?? null,
		eventCount: events.length,
		averageDays: averageIntervalDays(events),
		missingDetails: events.some((entry) =>
			axle === 'front'
				? !entry.frontDetails?.trim()
				: !entry.rearDetails?.trim(),
		),
	};
};

export const buildTireReport = (entries: ConsumableEntry[]): TireReport => {
	const tires = entries.filter(isTireEntry);
	const fluidEntries = entries
		.filter((entry) => entry.kind !== 'tires' && !entry.deletedAt)
		.sort((a, b) => b.performedAt.localeCompare(a.performedAt));
	const missingCostEntries = tires.filter((entry) => {
		const frontMissing =
			includesAxle(entry, 'front') && entry.frontCost == null;
		const rearMissing = includesAxle(entry, 'rear') && entry.rearCost == null;
		return frontMissing || rearMissing;
	}).length;
	return {
		front: reportAxle(tires, 'front'),
		rear: reportAxle(tires, 'rear'),
		spend: {
			front: tires.reduce((total, entry) => total + (entry.frontCost ?? 0), 0),
			rear: tires.reduce((total, entry) => total + (entry.rearCost ?? 0), 0),
			combined: tires.reduce(
				(total, entry) =>
					total + (entry.frontCost ?? 0) + (entry.rearCost ?? 0),
				0,
			),
			missingCostEntries,
		},
		fluidEntries,
	};
};

@Component({
	selector: 'app-consumable-maintenance',
	imports: [CommonModule, DatePipe, FormsModule],
	templateUrl: './consumable-maintenance.html',
	styleUrl: './consumable-maintenance.css',
})
export class ConsumableMaintenance {
	private readonly http = inject(HttpClient);
	private readonly store = inject(MaintenanceStore);
	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly entries = linkedSignal(() =>
		this.store.consumableEntries(),
	);
	protected readonly timezone = this.store.timezone;
	private readonly mutationError = signal('');
	protected readonly state = computed(() =>
		this.store.loading() ? 'loading' : this.store.error() ? 'error' : 'ready',
	);
	protected readonly error = computed(
		() => this.mutationError() || this.store.error(),
	);
	protected readonly formError = signal('');
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
	protected readonly historyFilter = signal<'active' | 'archived'>('active');
	protected readonly hasActiveCars = computed(() =>
		this.garage().some((car) => !car.archivedAt),
	);
	protected readonly form = signal<EntryForm>(emptyForm());
	protected readonly report = computed(() => {
		const local = buildTireReport(this.entries());
		const server = this.store.report();
		if (
			!server?.tires?.frequency?.front ||
			!server.tires.frequency.rear ||
			!server.tires.spend?.front ||
			!server.tires.spend.rear ||
			!server.tires.spend.combined
		)
			return local;
		return {
			...local,
			front: {
				...local.front,
				eventCount: server.tires.frequency.front.eventCount,
				averageDays: server.tires.frequency.front.averageIntervalDays,
			},
			rear: {
				...local.rear,
				eventCount: server.tires.frequency.rear.eventCount,
				averageDays: server.tires.frequency.rear.averageIntervalDays,
			},
			spend: {
				...local.spend,
				front: server.tires.spend.front.total ?? local.spend.front,
				rear: server.tires.spend.rear.total ?? local.spend.rear,
				combined: server.tires.spend.combined.total ?? local.spend.combined,
			},
		};
	});

	protected load(): void {
		this.mutationError.set('');
		this.store.refreshConsumables();
	}
	protected visibleEntries(): ConsumableEntry[] {
		return this.entries().filter((entry) =>
			this.historyFilter() === 'archived'
				? Boolean(entry.deletedAt)
				: !entry.deletedAt,
		);
	}
	protected openCreate(): void {
		if (!this.hasActiveCars()) return;
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
			frontCost:
				entry.kind === 'tires'
					? entry.frontCost == null
						? ''
						: String(entry.frontCost)
					: entry.cost == null
						? ''
						: String(entry.cost),
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
			((form.axle !== 'rear' &&
				!form.frontDetails.trim() &&
				!form.frontCost.trim()) ||
				(form.axle !== 'front' &&
					!form.rearDetails.trim() &&
					!form.rearCost.trim()))
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
			next: () => {
				this.store.refreshConsumables();
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
				next: () => {
					this.store.refreshConsumables();
					this.action.set(null);
				},
				error: () => {
					this.action.set(null);
					this.mutationError.set(
						'That consumable entry could not be archived.',
					);
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
				next: () => {
					this.store.refreshConsumables();
					this.action.set(null);
				},
				error: () => {
					this.action.set(null);
					this.mutationError.set(
						'That consumable entry could not be restored.',
					);
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
	protected axleDetails(entry: ConsumableEntry, axle: string): string {
		const details = axle === 'front' ? entry.frontDetails : entry.rearDetails;
		return details?.trim() || 'Details not recorded.';
	}
	protected axleCost(entry: ConsumableEntry, axle: string): number | null {
		return axle === 'front'
			? (entry.frontCost ?? null)
			: (entry.rearCost ?? null);
	}
	protected entryCost(entry: ConsumableEntry): string {
		const isFluid = entry.kind !== 'tires';
		const hasCost = isFluid
			? entry.cost !== null && entry.cost !== undefined
			: (entry.frontCost !== null && entry.frontCost !== undefined) ||
				(entry.rearCost !== null && entry.rearCost !== undefined);
		const total = isFluid
			? (entry.cost ?? 0)
			: (entry.frontCost ?? 0) + (entry.rearCost ?? 0);
		return hasCost
			? `${entry.currency ?? 'USD'} ${total.toFixed(2)}`
			: 'No cost logged';
	}
	protected setHistoryFilter(value: 'active' | 'archived'): void {
		this.historyFilter.set(value);
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
		const parts = new Intl.DateTimeFormat('en-CA', {
			timeZone: this.timezone(),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(date);
		const get = (type: string) =>
			parts.find((part) => part.type === type)?.value ?? '';
		return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
	}
	private toIso(value: string): string {
		const [date, time] = value.split('T');
		if (!date || !time) return '';
		const [year, month, day] = date.split('-').map(Number);
		const [hour, minute] = time.split(':').map(Number);
		const asUtc = Date.UTC(year, month - 1, day, hour, minute);
		const parts = new Intl.DateTimeFormat('en-US', {
			timeZone: this.timezone(),
			year: 'numeric',
			month: '2-digit',
			day: '2-digit',
			hour: '2-digit',
			minute: '2-digit',
			hourCycle: 'h23',
		}).formatToParts(new Date(asUtc));
		const get = (type: string) =>
			Number(parts.find((part) => part.type === type)?.value);
		const offset =
			Date.UTC(
				get('year'),
				get('month') - 1,
				get('day'),
				get('hour'),
				get('minute'),
			) - asUtc;
		return new Date(asUtc - offset).toISOString();
	}
}
