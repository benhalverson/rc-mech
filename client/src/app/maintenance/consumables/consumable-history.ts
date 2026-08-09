import { DatePipe, DecimalPipe } from '@angular/common';
import {
	Component,
	computed,
	effect,
	inject,
	model,
	output,
	signal,
} from '@angular/core';
import {
	LucideArchive,
	LucideArchiveRestore,
	LucideHistory,
	LucidePencil,
	LucidePlus,
	LucideTriangleAlert,
} from '@lucide/angular';
import type { ConsumableEntry } from '../maintenance.models';
import {
	buildTireReport,
	canCreateConsumableEntry,
	canEditConsumableEntry,
	consumableEntryIsReadOnly,
	mergeTireReport,
	spendLabel,
	visibleConsumableEntries,
} from './consumable.rules';
import { ConsumableStore } from './consumable-store';

@Component({
	selector: 'app-consumable-history',
	imports: [
		DatePipe,
		DecimalPipe,
		LucideArchive,
		LucideArchiveRestore,
		LucideHistory,
		LucidePencil,
		LucidePlus,
		LucideTriangleAlert,
	],
	templateUrl: './consumable-history.html',
	host: { class: 'contents' },
})
export class ConsumableHistory {
	private readonly store = inject(ConsumableStore);
	private readonly handledOperationId = signal(
		this.store.outcome().operationId ?? 0,
	);

	readonly filter = model<'active' | 'archived'>('active');
	readonly createRequested = output<void>();
	readonly editRequested = output<ConsumableEntry>();

	protected readonly garage = computed(() => this.store.cars());
	protected readonly timezone = this.store.timezone;
	protected readonly action = this.store.action;
	protected readonly error = signal('');
	protected readonly reportAxles = ['front', 'rear'] as const;
	protected readonly hasActiveCars = computed(() =>
		this.garage().some((car) => !car.archivedAt),
	);
	protected readonly visibleEntries = computed(() =>
		visibleConsumableEntries(this.store.entries(), this.filter()),
	);
	protected readonly report = computed(() =>
		mergeTireReport(buildTireReport(this.store.entries()), this.store.report()),
	);
	protected readonly spendLabel = spendLabel;

	constructor() {
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOperationId()
			)
				return;
			this.handledOperationId.set(outcome.operationId);
			if (outcome.status !== 'failed' || outcome.command.kind !== 'change')
				return;
			if (outcome.failure === 'archive-failed')
				this.error.set('That consumable entry could not be archived.');
			else this.error.set('That consumable entry could not be restored.');
		});
	}

	protected create(): void {
		if (!canCreateConsumableEntry(this.garage(), this.action())) return;
		this.createRequested.emit();
	}

	protected edit(entry: ConsumableEntry): void {
		if (!canEditConsumableEntry(entry, this.garage(), this.action())) return;
		this.editRequested.emit(entry);
	}

	protected archive(entry: ConsumableEntry): void {
		if (this.isReadOnly(entry) || this.action()) return;
		this.error.set('');
		this.store.mutate({ kind: 'change', action: 'archive', entry });
	}

	protected restore(entry: ConsumableEntry): void {
		if (this.action()) return;
		this.error.set('');
		this.store.mutate({ kind: 'change', action: 'restore', entry });
	}

	protected isReadOnly(entry: ConsumableEntry): boolean {
		return consumableEntryIsReadOnly(entry, this.garage());
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

	protected axleDetails(
		entry: ConsumableEntry,
		axle: 'front' | 'rear',
	): string {
		const details = axle === 'front' ? entry.frontDetails : entry.rearDetails;
		return details?.trim() || 'Details not recorded.';
	}

	protected axleCost(
		entry: ConsumableEntry,
		axle: 'front' | 'rear',
	): number | null {
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
}
