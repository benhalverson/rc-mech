import { DOCUMENT } from '@angular/common';
import { DestroyRef, inject, Service, signal } from '@angular/core';

@Service()
export class PageVisibilityCapability {
	private readonly document = inject(DOCUMENT);
	private readonly destroyRef = inject(DestroyRef);
	readonly hidden = signal(this.document.visibilityState === 'hidden');

	constructor() {
		const update = () =>
			this.hidden.set(this.document.visibilityState === 'hidden');
		this.document.addEventListener('visibilitychange', update);
		this.destroyRef.onDestroy(() =>
			this.document.removeEventListener('visibilitychange', update),
		);
	}
}
