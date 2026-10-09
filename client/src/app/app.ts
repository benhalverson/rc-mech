import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RouteTransitionAnnouncer } from './route-transition-announcer';
import { SignOutRecovery } from './shell/sign-out-recovery';

@Component({
	selector: 'app-root',
	imports: [RouterOutlet],
	templateUrl: './app.html',
	styleUrl: './app.css',
})
export class App {
	protected readonly signOutRecovery = inject(SignOutRecovery);
	protected readonly transition = inject(RouteTransitionAnnouncer);
}
