import { Component, computed, input, model, output } from '@angular/core';
import { FormField, form } from '@angular/forms/signals';
import { LucideTriangleAlert } from '@lucide/angular';
import type { ImportCarOption, SoDialedImportPreview } from './setup-snapshot';

export type ImportedCarIdentity = {
	readonly name: string;
	readonly make: string;
	readonly model: string;
};

@Component({
	selector: 'app-setup-import-review',
	imports: [FormField, LucideTriangleAlert],
	templateUrl: './setup-import-review.html',
})
export class SetupImportReview {
	readonly preview = input.required<SoDialedImportPreview>();
	readonly availableCars = input<ImportCarOption[]>([]);
	readonly selection = model({ carId: '' });
	readonly createCarFromImport = output<ImportedCarIdentity>();
	protected readonly targetForm = form(this.selection);
	protected readonly mappedValueCount = computed(() => {
		const sections = this.preview().sections;
		return [
			sections.vehicle,
			sections.drivetrain,
			sections.electronics,
			sections.tires,
			sections.shocks,
			sections.frontSuspension,
			sections.rearSuspension,
		].reduce((count, values) => count + this.importValueCount(values), 0);
	});

	protected requestCreateCar(): void {
		const identity = this.preview().carIdentity;
		this.createCarFromImport.emit({
			name:
				identity.name ||
				[identity.make, identity.model].filter(Boolean).join(' ') ||
				'Imported car',
			make: identity.make ?? '',
			model: identity.model ?? '',
		});
	}

	protected importValueCount(values: Record<string, unknown>): number {
		return Object.keys(values).length;
	}
}
