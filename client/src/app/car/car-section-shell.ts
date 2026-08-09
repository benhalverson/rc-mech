import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { GarageCar } from '../garage/garage-store';
import {
	CAR_WORKSPACE_SECTIONS,
	type CarWorkspaceSection,
} from '../shell/shell-route-context';

export type CarSection = CarWorkspaceSection;

@Component({
	selector: 'app-car-section-shell',
	imports: [RouterLink],
	templateUrl: './car-section-shell.html',
	styleUrl: './car-section-shell.css',
})
export class CarSectionShell {
	readonly car = input.required<GarageCar>();
	readonly section = input.required<CarSection>();
	protected readonly sections = CAR_WORKSPACE_SECTIONS;
}
