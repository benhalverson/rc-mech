import { BreakpointObserver } from '@angular/cdk/layout';
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
	private readonly breakpointObserver = inject(BreakpointObserver, {
		optional: true,
	});
	protected readonly transition = inject(RouteTransitionAnnouncer);
	protected readonly mobileNav = signal(
		typeof window !== 'undefined' &&
			typeof window.matchMedia === 'function' &&
			window.matchMedia('(max-width: 700px)').matches,
	);
	protected readonly navOpen = signal(!this.mobileNav());
	protected readonly signOutMessage = signal('');
	protected readonly checking = computed(
		() =>
			this.sessionStore.session.isLoading() &&
			!this.sessionStore.session.hasValue(),
	);
	protected readonly signedIn = this.sessionStore.authenticated;
	protected readonly ownerEmail = this.sessionStore.ownerEmail;

	constructor() {
		this.breakpointObserver
			?.observe(['(max-width: 700px)'])
			.subscribe(({ matches }) => {
				this.mobileNav.set(matches);
				this.navOpen.set(!matches);
			});
	}

	protected openNav(): void {
		this.navOpen.set(true);
	}

	protected closeNav(): void {
		this.navOpen.set(false);
	}

	protected selectNav(): void {
		if (this.mobileNav()) this.closeNav();
	}

	protected signOut(): void {
		this.signOutMessage.set('');
		this.http
			.post('/api/auth/sign-out', {}, { withCredentials: true })
			.subscribe({
				next: () => {
					this.sessionStore.expire();
					void this.router.navigate(['/sign-in']);
				},
				error: () =>
					this.signOutMessage.set('We could not sign you out. Try again.'),
			});
	}
}
