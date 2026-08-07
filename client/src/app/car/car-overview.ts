import { Component, effect, inject, input } from '@angular/core';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

@Component({
	selector: 'app-car-overview',
	imports: [CarSectionShell],
	template: `
		@if (store.loading()) {
			<div class="state-card" role="status">Opening the car overview…</div>
		} @else if (store.error()) {
			<div class="state-card" role="alert"><p>The car overview could not be loaded.</p><button type="button" (click)="store.retry()">Try again</button></div>
		} @else if (store.car(); as car) {
			<app-car-section-shell [car]="car" section="overview">
				<section class="overview" aria-labelledby="overview-title">
					<div class="section-heading"><div><div class="eyebrow">Inspection plate</div><h3 id="overview-title">Car overview</h3></div>
					@if (car.archivedAt) { <button type="button" (click)="store.changeArchiveState('restore')" [disabled]="store.lifecycleAction() !== null">{{ store.lifecycleAction() === 'restore' ? 'Restoring…' : 'Restore car' }}</button> }
					@else { <button type="button" (click)="store.changeArchiveState('archive')" [disabled]="store.lifecycleAction() !== null">{{ store.lifecycleAction() === 'archive' ? 'Archiving…' : 'Archive car' }}</button> }</div>
					@if (store.lifecycleError()) { <p role="alert">{{ store.lifecycleError() }}</p> }
					<dl><div><dt>Scale</dt><dd>{{ car.scale || 'Not recorded' }}</dd></div><div><dt>Vehicle type</dt><dd>{{ car.vehicleType || 'Not recorded' }}</dd></div><div><dt>Power type</dt><dd>{{ car.powerType || 'Not recorded' }}</dd></div></dl>
					<p><strong>Workshop notes</strong><br />{{ car.notes || 'No notes recorded yet.' }}</p>
				</section>
			</app-car-section-shell>
		}
	`,
	styleUrl: '../garage/garage.css',
})
export class CarOverview {
	readonly carId = input('');
	protected readonly store = inject(CarStore);

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (carId) this.store.selectCar(carId);
		});
	}
}
