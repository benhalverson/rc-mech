import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { OwnerSessionStore } from './owner-session-store';
import { RouteTransitionAnnouncer } from './route-transition-announcer';
import { ResponsiveViewport } from './shell/responsive-viewport';
import { SignOutStore } from './shell/sign-out-store';

@Component({
	selector: 'app-root',
	imports: [RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './app.html',
	styleUrl: './garage-pages.css',
})
export class App {
	protected readonly sessionStore = inject(OwnerSessionStore);
	private readonly responsiveViewport = inject(ResponsiveViewport);
	protected readonly signOutStore = inject(SignOutStore);
	protected readonly transition = inject(RouteTransitionAnnouncer);
	private navToggle!: HTMLButtonElement;
	protected readonly mobileNav = this.responsiveViewport.mobile;
	protected readonly navOpen = signal(!this.mobileNav());
	protected readonly checking = computed(
		() =>
			this.sessionStore.session.isLoading() &&
			!this.sessionStore.session.hasValue(),
	);
	protected readonly signedIn = this.sessionStore.authenticated;
	protected readonly ownerEmail = this.sessionStore.ownerEmail;

	constructor() {
		effect(() => this.navOpen.set(!this.mobileNav()));
	}

	protected openNav(navToggle: HTMLButtonElement): void {
		this.navToggle = navToggle;
		this.navOpen.set(true);
	}

	protected closeNav(): void {
		this.navOpen.set(false);
		if (this.mobileNav()) this.navToggle.focus();
	}

	protected selectNav(): void {
		if (this.mobileNav()) this.navOpen.set(false);
	}

	protected signOut(): void {
		this.signOutStore.signOut({ operation: 'sign-out' });
	}
}
