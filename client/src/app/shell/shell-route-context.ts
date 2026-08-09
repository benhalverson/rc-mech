import { computed, inject, Service } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NavigationEnd, Router } from '@angular/router';
import { distinctUntilChanged, filter, map } from 'rxjs';

export type CarWorkspaceSection =
	| 'overview'
	| 'build'
	| 'setups'
	| 'photos'
	| 'drive-sessions'
	| 'voice';

export const CAR_WORKSPACE_SECTIONS: ReadonlyArray<{
	path: CarWorkspaceSection;
	label: string;
}> = [
	{ path: 'overview', label: 'Overview' },
	{ path: 'build', label: 'Build' },
	{ path: 'setups', label: 'Setups' },
	{ path: 'photos', label: 'Photos' },
	{ path: 'drive-sessions', label: 'Drive sessions' },
	{ path: 'voice', label: 'Voice log' },
];

const sectionPaths = new Set<CarWorkspaceSection>(
	CAR_WORKSPACE_SECTIONS.map(({ path }) => path),
);

export type CarWorkspaceRoute = {
	carId: string;
	section: CarWorkspaceSection;
};

const segmentValue = (segment: string): string => segment.replace(/;.*/, '');

export const carWorkspaceRouteFromUrl = (
	url: string,
): CarWorkspaceRoute | null => {
	const path = url.replace(/[?#].*$/, '');
	const segments = path.split('/').filter(Boolean).map(segmentValue);
	if (
		segments.length !== 3 ||
		segments[0] !== 'garage' ||
		!sectionPaths.has(segments[2] as CarWorkspaceSection)
	)
		return null;
	try {
		return {
			carId: decodeURIComponent(segments[1] as string),
			section: segments[2] as CarWorkspaceSection,
		};
	} catch {
		return null;
	}
};

@Service()
export class ShellRouteContext {
	private readonly router = inject(Router);
	private readonly currentUrl = toSignal(
		this.router.events.pipe(
			filter((event): event is NavigationEnd => event instanceof NavigationEnd),
			map((event) => event.urlAfterRedirects),
			distinctUntilChanged(),
		),
		{ initialValue: this.router.url },
	);
	readonly carWorkspace = computed(() =>
		carWorkspaceRouteFromUrl(this.currentUrl()),
	);
	readonly carId = computed(() => this.carWorkspace()?.carId ?? null);
	readonly section = computed(() => this.carWorkspace()?.section ?? null);
}
