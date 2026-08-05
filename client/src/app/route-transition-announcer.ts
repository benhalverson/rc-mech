import { Injectable, signal } from '@angular/core';
import { NavigationEnd, NavigationStart, Router } from '@angular/router';
import { filter } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class RouteTransitionAnnouncer {
	readonly loading = signal(false);
	readonly announcement = signal('');

	constructor(router: Router) {
		router.events
			.pipe(
				filter(
					(event) =>
						event instanceof NavigationStart || event instanceof NavigationEnd,
				),
			)
			.subscribe((event) => {
				if (event instanceof NavigationStart) {
					this.start();
					return;
				}
				this.loading.set(false);
				this.announcement.set(`Opened ${this.label(event.urlAfterRedirects)}.`);
				queueMicrotask(() => {
					const heading = document.querySelector<HTMLElement>(
						'main[tabindex="-1"]',
					);
					heading?.focus({ preventScroll: true });
				});
			});
	}

	start(): void {
		this.loading.set(true);
		this.announcement.set('Loading workspace…');
	}

	private label(url: string): string {
		if (url.startsWith('/garage')) return 'Garage';
		if (url.startsWith('/maintenance')) return 'Maintenance';
		if (url.startsWith('/settings')) return 'Settings';
		return 'workspace';
	}
}
