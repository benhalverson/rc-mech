import {
	afterNextRender,
	Component,
	computed,
	ElementRef,
	Injector,
	inject,
	linkedSignal,
	viewChild,
} from '@angular/core';
import { RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { OfflineStatus } from '../offline/offline-status';
import { OwnerSessionStore } from '../owner-session-store';
import { RouteTransitionAnnouncer } from '../route-transition-announcer';
import { ResponsiveViewport } from './responsive-viewport';
import { ShellCarStore } from './shell-car-store';
import {
	CAR_WORKSPACE_SECTIONS,
	type CarWorkspaceSection,
} from './shell-route-context';
import { SignOutStore } from './sign-out-store';

@Component({
	selector: 'app-workspace-shell',
	imports: [OfflineStatus, RouterLink, RouterLinkActive, RouterOutlet],
	templateUrl: './workspace-shell.html',
	styleUrl: './workspace-shell.css',
})
export class WorkspaceShell {
	protected readonly sessionStore = inject(OwnerSessionStore);
	private readonly responsiveViewport = inject(ResponsiveViewport);
	private readonly injector = inject(Injector);
	protected readonly cars = inject(ShellCarStore);
	protected readonly signOutStore = inject(SignOutStore);
	protected readonly transition = inject(RouteTransitionAnnouncer);
	private readonly navClose =
		viewChild<ElementRef<HTMLButtonElement>>('navClose');
	private readonly pickerClose =
		viewChild<ElementRef<HTMLButtonElement>>('pickerClose');
	private navToggle?: HTMLButtonElement;
	private pickerToggle?: HTMLButtonElement;
	protected readonly mobileNav = this.responsiveViewport.mobile;
	protected readonly navOpen = linkedSignal(() => {
		this.mobileNav();
		return false;
	});
	protected readonly pickerOpen = linkedSignal(() => {
		this.mobileNav();
		this.cars.carId();
		return false;
	});
	protected readonly overlayOpen = computed(
		() => this.mobileNav() && (this.navOpen() || this.pickerOpen()),
	);
	protected readonly ownerEmail = this.sessionStore.ownerEmail;
	protected readonly carSections = CAR_WORKSPACE_SECTIONS;
	protected readonly currentCarName = computed(() => {
		const car = this.cars.currentCar();
		if (car) return car.name;
		if (this.cars.loading()) return 'Loading current car…';
		if (this.cars.error()) return 'Current car unavailable';
		return 'Current car';
	});

	protected openNav(navToggle: HTMLButtonElement): void {
		this.pickerOpen.set(false);
		this.navToggle = navToggle;
		this.navOpen.set(true);
		this.focusAfterRender(() => this.navClose()?.nativeElement);
	}

	protected closeNav(restoreFocus = true): void {
		this.navOpen.set(false);
		if (restoreFocus && this.mobileNav())
			this.focusAfterRender(() => this.navToggle);
	}

	protected selectNav(): void {
		this.closeNav(false);
	}

	protected openPicker(pickerToggle: HTMLButtonElement): void {
		this.navOpen.set(false);
		this.pickerToggle = pickerToggle;
		this.pickerOpen.set(true);
		this.focusAfterRender(() => this.pickerClose()?.nativeElement);
	}

	protected closePicker(restoreFocus = true): void {
		this.pickerOpen.set(false);
		if (restoreFocus && this.mobileNav())
			this.focusAfterRender(() => this.pickerToggle);
	}

	protected selectCar(): void {
		this.closePicker(false);
	}

	protected trapFocus(event: Event, container: HTMLElement): void {
		const keyboardEvent = event as KeyboardEvent;
		if (keyboardEvent.key !== 'Tab') return;
		const focusable = Array.from(
			container.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])',
			),
		).filter((element) => !element.hasAttribute('inert'));
		const first = focusable.at(0);
		const last = focusable.at(-1);
		if (!first || !last) return;
		if (
			keyboardEvent.shiftKey &&
			container.ownerDocument.activeElement === first
		) {
			keyboardEvent.preventDefault();
			last.focus();
		} else if (
			!keyboardEvent.shiftKey &&
			container.ownerDocument.activeElement === last
		) {
			keyboardEvent.preventDefault();
			first.focus();
		}
	}

	protected carRoute(
		carId: string,
		section: CarWorkspaceSection | null = this.cars.section(),
	): string[] {
		return ['/garage', carId, section ?? 'overview'];
	}

	protected signOut(): void {
		this.navOpen.set(false);
		this.pickerOpen.set(false);
		this.signOutStore.signOut({ operation: 'sign-out' });
	}

	private focusAfterRender(target: () => HTMLElement | undefined): void {
		afterNextRender(() => target()?.focus(), { injector: this.injector });
	}
}
