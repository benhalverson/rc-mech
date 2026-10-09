import { Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { RouteTransitionAnnouncer } from './route-transition-announcer';
import { SignOutRecovery } from './shell/sign-out-recovery';

/**
 * Application composition root for route rendering, route announcements, and
 * session-cleanup bootstrap. Starts lightweight deferred sign-out recovery even
 * on public routes without eagerly instantiating the authenticated workspace.
 */
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
