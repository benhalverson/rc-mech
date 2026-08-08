import { Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import type { GarageCar } from '../garage/garage-store';

export type CarSection =
	| 'overview'
	| 'build'
	| 'setups'
	| 'photos'
	| 'runs'
	| 'voice';

@Component({
	selector: 'app-car-section-shell',
	imports: [RouterLink],
	template: `
		<a class="back-link" routerLink="/garage">← Garage collection</a>
		<header>
			<div class="eyebrow">{{ car().archivedAt ? 'Archived record' : 'Active car' }}</div>
			<h2 data-route-focus tabindex="-1">{{ car().name }}</h2>
			<p>{{ car().make || car().manufacturer || 'Make not recorded' }} · {{ car().model || 'Model not recorded' }}</p>
		</header>
		@if (car().archivedAt) { <p class="archive-note">This car is archived. Its history is available, but changes are disabled until it is restored.</p> }
		<nav aria-label="Car detail sections">
			@for (item of sections; track item.path) {
				<a [routerLink]="['/garage', car().id, item.path]" [attr.aria-current]="section() === item.path ? 'page' : null">{{ item.label }}</a>
			}
		</nav>
		<ng-content />
	`,
	styles: `
		:host { display: grid; gap: 20px; }
		.back-link { color: var(--accent); width: fit-content; }
		header h2, header p { margin: 5px 0 0; }
		nav { display: flex; flex-wrap: wrap; gap: 8px; border-bottom: 1px solid var(--line); }
		nav a { color: var(--muted); padding: 10px; text-decoration: none; }
		nav a[aria-current='page'] { color: var(--accent); border-bottom: 2px solid var(--accent); }
		nav a:focus-visible, .back-link:focus-visible { outline: 2px solid var(--accent); outline-offset: 3px; }
	`,
})
export class CarSectionShell {
	readonly car = input.required<GarageCar>();
	readonly section = input.required<CarSection>();
	protected readonly sections: Array<{ path: CarSection; label: string }> = [
		{ path: 'overview', label: 'Overview' },
		{ path: 'build', label: 'Build' },
		{ path: 'setups', label: 'Setups' },
		{ path: 'photos', label: 'Photos' },
		{ path: 'runs', label: 'Runs' },
		{ path: 'voice', label: 'Voice log' },
	];
}
