import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

@Component({
	selector: 'app-root',
	imports: [RouterOutlet],
	templateUrl: './app.html',
	styleUrl: './app.css',
})
export class App {
	protected readonly transition = inject(RouteTransitionAnnouncer);
}
