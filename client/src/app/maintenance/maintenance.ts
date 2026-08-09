import { Component } from '@angular/core';
import { MaintenanceCockpit } from '../maintenance-cockpit';

@Component({
	selector: 'app-maintenance',
	imports: [MaintenanceCockpit],
	templateUrl: './maintenance.html',
})
export class Maintenance {}
