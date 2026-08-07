import { Component } from '@angular/core';
import { MaintenanceCockpit } from '../maintenance-cockpit';

@Component({
	selector: 'app-maintenance',
	imports: [MaintenanceCockpit],
	template: '<app-maintenance-cockpit />',
})
export class Maintenance {}
