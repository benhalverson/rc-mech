import { DOCUMENT } from '@angular/common';
import {
	DestroyRef,
	InjectionToken,
	inject,
	Service,
	signal,
} from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import {
	NavigationCancel,
	NavigationEnd,
	NavigationError,
	NavigationStart,
	Router,
} from '@angular/router';
import { filter } from 'rxjs';

export const ROUTE_RELOADER = new InjectionToken<(url: string) => void>(
	'ROUTE_RELOADER',
	{
		providedIn: 'root',
		factory: () => {
			const view = inject(DOCUMENT).defaultView;
			return (url) => view?.location.assign(url);
		},
	},
);

@Service()
export class RouteTransitionAnnouncer {
	private readonly document = inject(DOCUMENT);
	private readonly router = inject(Router);
	private readonly destroyRef = inject(DestroyRef);
	private readonly reloadRoute = inject(ROUTE_RELOADER);
	private focusObserver?: MutationObserver;
	readonly loading = signal(false);
	readonly checkingWorkspace = signal(false);
	readonly announcement = signal('');
	readonly error = signal('');
	private lastUrl = '/garage';
	private completedNavigation = false;

	constructor() {
		this.destroyRef.onDestroy(() => {
			this.focusObserver?.disconnect();
			this.focusObserver = undefined;
		});
		this.router.events
			.pipe(
				filter(
					(event) =>
						event instanceof NavigationStart ||
						event instanceof NavigationEnd ||
						event instanceof NavigationCancel ||
						event instanceof NavigationError,
				),
				takeUntilDestroyed(this.destroyRef),
			)
			.subscribe((event) => {
				if (event instanceof NavigationStart) {
					this.lastUrl = event.url;
					this.checkingWorkspace.set(
						!this.completedNavigation &&
							/^\/(?:garage(?:[/?#]|$)|maintenance(?:[/?#]|$)|settings(?:[/?#]|$))/.test(
								event.url,
							),
					);
					this.start();
					return;
				}
				if (event instanceof NavigationError) {
					this.loading.set(false);
					this.checkingWorkspace.set(false);
					this.error.set('This page could not be loaded. Try again.');
					this.announcement.set('');
					return;
				}
				if (event instanceof NavigationCancel) {
					this.loading.set(false);
					this.checkingWorkspace.set(false);
					return;
				}
				this.loading.set(false);
				this.checkingWorkspace.set(false);
				this.completedNavigation = true;
				this.error.set('');
				this.announcement.set(`Opened ${this.label(event.urlAfterRedirects)}.`);
				queueMicrotask(() => this.focusRouteHeading());
			});
	}

	start(): void {
		this.focusObserver?.disconnect();
		this.focusObserver = undefined;
		this.loading.set(true);
		this.error.set('');
		this.announcement.set('Loading page…');
	}

	retry(): void {
		this.reloadRoute(this.lastUrl);
	}

	private label(url: string): string {
		if (url.startsWith('/garage')) return 'Garage';
		if (url.startsWith('/maintenance')) return 'Maintenance';
		if (url.startsWith('/settings')) return 'Settings';
		if (url.startsWith('/sign-in')) return 'Sign in';
		return 'page';
	}

	private focusRouteHeading(): void {
		this.focusObserver?.disconnect();
		if (this.focusCurrentHeading()) return;

		const MutationObserver = this.document.defaultView?.MutationObserver;
		if (!MutationObserver || !this.document.body) return;
		this.focusObserver = new MutationObserver(() => {
			if (!this.focusCurrentHeading()) return;
			this.focusObserver?.disconnect();
			this.focusObserver = undefined;
		});
		this.focusObserver.observe(this.document.body, {
			childList: true,
			subtree: true,
		});
	}

	private focusCurrentHeading(): boolean {
		for (const heading of this.document.querySelectorAll<HTMLElement>(
			'[data-route-focus]',
		)) {
			heading.focus({ preventScroll: true });
			if (this.document.activeElement === heading) return true;
		}
		return false;
	}
}
