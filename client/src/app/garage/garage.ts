import { Component, inject } from '@angular/core';
import { ActivatedRoute, RouterLink } from '@angular/router';
import { GarageStore } from './garage-store';

@Component({
	selector: 'app-garage',
	imports: [RouterLink],
	templateUrl: './garage.html',
	styleUrl: './garage.css',
})
export class Garage {
	protected readonly store = inject(GarageStore);

	constructor() {
		this.store.selectCar(inject(ActivatedRoute).snapshot.paramMap.get('carId'));
	}
}
