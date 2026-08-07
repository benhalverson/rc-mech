import { Component, effect, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { map } from 'rxjs';
import { GarageStore } from './garage-store';

@Component({
	selector: 'app-garage',
	imports: [RouterLink],
	templateUrl: './garage.html',
	styleUrl: './garage.css',
})
export class Garage {
	protected readonly store = inject(GarageStore);
	private readonly route = inject(ActivatedRoute);
	private readonly routeCarId = toSignal(
		this.route.paramMap.pipe(map((params) => params.get('carId'))),
		{ initialValue: this.route.snapshot.paramMap.get('carId') },
	);

	constructor() {
		effect(() => this.store.selectCar(this.routeCarId()));
	}
}
