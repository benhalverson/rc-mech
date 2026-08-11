import {
	DestroyRef,
	InjectionToken,
	inject,
	Service,
	signal,
} from '@angular/core';

export type OfflineConnectivityBrowser = Readonly<{
	online: boolean;
	addEventListener(type: 'online' | 'offline', listener: EventListener): void;
	removeEventListener(
		type: 'online' | 'offline',
		listener: EventListener,
	): void;
}>;

export const currentOfflineConnectivityBrowser =
	(): OfflineConnectivityBrowser => ({
		online: globalThis.navigator?.onLine ?? true,
		addEventListener: (type, listener) =>
			globalThis.addEventListener(type, listener),
		removeEventListener: (type, listener) =>
			globalThis.removeEventListener(type, listener),
	});

export const OFFLINE_CONNECTIVITY_BROWSER =
	new InjectionToken<OfflineConnectivityBrowser>(
		'OFFLINE_CONNECTIVITY_BROWSER',
		{ factory: currentOfflineConnectivityBrowser },
	);

@Service()
export class OfflineConnectivity {
	private readonly browser = inject(OFFLINE_CONNECTIVITY_BROWSER);
	readonly retryHint = signal(0);
	private retryTimer: ReturnType<typeof setTimeout> | null = null;
	private retryAttempt = 0;
	private readonly wentOnline = (): void => {
		const previousHint = this.retryHint();
		this.markRequestSucceeded();
		if (this.retryHint() === previousHint)
			this.retryHint.update((value) => value + 1);
	};
	private readonly wentOffline = (): void => undefined;

	constructor() {
		this.browser.addEventListener('online', this.wentOnline);
		this.browser.addEventListener('offline', this.wentOffline);
		inject(DestroyRef).onDestroy(() => {
			this.cancelRetry();
			this.browser.removeEventListener('online', this.wentOnline);
			this.browser.removeEventListener('offline', this.wentOffline);
		});
	}

	scheduleRetry(): void {
		if (this.retryTimer !== null) return;
		const delay = Math.min(500 * 2 ** this.retryAttempt, 10_000);
		this.retryAttempt += 1;
		this.retryTimer = setTimeout(() => {
			this.retryTimer = null;
			this.retryHint.update((value) => value + 1);
		}, delay);
	}

	markRequestSucceeded(): void {
		const recoveryPending = this.retryTimer !== null;
		this.retryAttempt = 0;
		this.cancelRetry();
		if (recoveryPending) this.retryHint.update((value) => value + 1);
	}

	private cancelRetry(): void {
		if (this.retryTimer === null) return;
		clearTimeout(this.retryTimer);
		this.retryTimer = null;
	}
}
