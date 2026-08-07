import { HttpClient } from '@angular/common/http';
import { Component, computed, inject, signal } from '@angular/core';
import {
	Router,
	RouterLink,
	RouterLinkActive,
	RouterOutlet,
} from '@angular/router';
import { OwnerSessionStore } from './owner-session-store';
import { RouteTransitionAnnouncer } from './route-transition-announcer';

@Component({
	selector: 'app-root',
	imports: [RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './app.html',
	styleUrl: './garage-pages.css',
})
export class App {
	protected readonly sessionStore = inject(OwnerSessionStore);
	private readonly http = inject(HttpClient);
	private readonly router = inject(Router);
	protected readonly transition = inject(RouteTransitionAnnouncer);
	protected readonly navOpen = signal(true);
	protected readonly signOutMessage = signal('');
	protected readonly checking = computed(
		() =>
			this.sessionStore.session.isLoading() &&
			!this.sessionStore.session.hasValue(),
	);
	protected readonly signedIn = this.sessionStore.authenticated;
	protected readonly ownerEmail = this.sessionStore.ownerEmail;

	protected signOut(): void {
		this.signOutMessage.set('');
		this.http
			.post('/api/auth/sign-out', {}, { withCredentials: true })
			.subscribe({
				next: () => {
					this.sessionStore.refresh();
					void this.router.navigate(['/sign-in']);
				},
				error: () =>
					this.signOutMessage.set('We could not sign you out. Try again.'),
			});
	}
}
