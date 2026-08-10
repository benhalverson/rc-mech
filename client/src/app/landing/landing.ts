import { NgOptimizedImage } from '@angular/common';
import { Component, computed, inject } from '@angular/core';
import { Meta, Title } from '@angular/platform-browser';
import { RouterLink } from '@angular/router';
import { AppearanceService } from '../appearance.service';

export const LANDING_TITLE = 'Chassis Notes — Setup history for RC racers';
export const LANDING_DESCRIPTION =
	'Keep your RC car’s current setup, intentional changes, Drive sessions, trackside voice notes, and maintenance history together in one private field notebook.';

@Component({
	selector: 'app-landing',
	host: { class: 'block min-h-dvh bg-alloy-canvas text-alloy-text' },
	imports: [NgOptimizedImage, RouterLink],
	templateUrl: './landing.html',
})
export class Landing {
	private readonly title = inject(Title);
	private readonly meta = inject(Meta);
	protected readonly appearance = inject(AppearanceService);
	protected readonly heroEvidence = computed(() =>
		this.appearance.resolved() === 'dark'
			? '/landing/current-setup-mobile-dark.png'
			: '/landing/current-setup-mobile-light.png',
	);
	protected readonly setupHistoryEvidence = computed(() =>
		this.appearance.resolved() === 'dark'
			? '/landing/setup-history-desktop-dark.png'
			: '/landing/setup-history-desktop-light.png',
	);
	protected readonly voiceReviewEvidence = computed(() =>
		this.appearance.resolved() === 'dark'
			? '/landing/voice-review-mobile-dark.png'
			: '/landing/voice-review-mobile-light.png',
	);
	protected readonly driveSessionEvidence = computed(() =>
		this.appearance.resolved() === 'dark'
			? '/landing/drive-session-desktop-dark.png'
			: '/landing/drive-session-desktop-light.png',
	);
	protected readonly tireServiceEvidence = computed(() =>
		this.appearance.resolved() === 'dark'
			? '/landing/tire-service-desktop-dark.png'
			: '/landing/tire-service-desktop-light.png',
	);

	constructor() {
		this.title.setTitle(LANDING_TITLE);
		this.meta.updateTag({ name: 'description', content: LANDING_DESCRIPTION });
	}

	protected revealWalkthrough(event: Event, walkthrough: HTMLElement): void {
		event.preventDefault();
		walkthrough.focus({ preventScroll: true });
		walkthrough.scrollIntoView({ behavior: 'auto', block: 'start' });
	}
}
