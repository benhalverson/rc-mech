import { DOCUMENT } from '@angular/common';
import { inject, Service, signal } from '@angular/core';
import {
	NavigationCancel,
	NavigationEnd,
	NavigationError,
	NavigationStart,
	Router,
} from '@angular/router';
import { filter } from 'rxjs';

@Service()
export class RouteTransitionAnnouncer {
	private readonly document = inject(DOCUMENT);
	private readonly router = inject(Router);
	readonly loading = signal(false);
	readonly announcement = signal('');
	readonly error = signal('');
	private lastUrl = '/garage';

	constructor() {
		this.router.events
			.pipe(
				filter(
					(event) =>
						event instanceof NavigationStart ||
						event instanceof NavigationEnd ||
						event instanceof NavigationCancel ||
						event instanceof NavigationError,
				),
			)
			.subscribe((event) => {
				if (event instanceof NavigationStart) {
					this.lastUrl = event.url;
					this.start();
					return;
				}
				if (event instanceof NavigationError) {
					this.loading.set(false);
					this.error.set('This workspace could not be loaded. Try again.');
					this.announcement.set('Workspace loading failed.');
					return;
				}
				if (event instanceof NavigationCancel) {
					this.loading.set(false);
					return;
				}
				this.loading.set(false);
				this.error.set('');
				this.announcement.set(`Opened ${this.label(event.urlAfterRedirects)}.`);
				queueMicrotask(() => this.focusRouteHeading());
			});
	}

	start(): void {
		this.loading.set(true);
		this.error.set('');
		this.announcement.set('Loading workspace…');
	}

	retry(): void {
		void this.router.navigateByUrl(this.lastUrl);
	}

	private label(url: string): string {
		if (url.startsWith('/garage')) return 'Garage';
		if (url.startsWith('/maintenance')) return 'Maintenance';
		if (url.startsWith('/settings')) return 'Settings';
		return 'workspace';
	}

	private focusRouteHeading(): void {
		this.document
			.querySelector<HTMLElement>('[data-route-focus]')
			?.focus({ preventScroll: true });
	}
}
