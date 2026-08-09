import { DOCUMENT } from '@angular/common';
import { computed, DestroyRef, inject, Service, signal } from '@angular/core';

export const APPEARANCE_STORAGE_KEY = 'rc-mech.appearance';

export type AppearancePreference = 'system' | 'light' | 'dark';
export type ResolvedAppearance = Exclude<AppearancePreference, 'system'>;

export const isAppearancePreference = (
	value: unknown,
): value is AppearancePreference =>
	value === 'system' || value === 'light' || value === 'dark';

@Service()
export class AppearanceService {
	private readonly document = inject(DOCUMENT);
	private readonly destroyRef = inject(DestroyRef);
	private readonly view = this.document.defaultView;
	private readonly persistenceState = signal(true);
	private readonly storage = this.findStorage();
	private readonly colorScheme = this.findColorScheme();
	private readonly systemDarkState = signal(this.colorScheme?.matches ?? false);
	private readonly preferenceState = signal(this.readPreference());

	readonly preference = this.preferenceState.asReadonly();
	readonly persistenceAvailable = this.persistenceState.asReadonly();
	readonly resolved = computed<ResolvedAppearance>(() => {
		const preference = this.preferenceState();
		return preference === 'system'
			? this.systemDarkState()
				? 'dark'
				: 'light'
			: preference;
	});

	constructor() {
		this.applyAppearance();
		this.listenForSystemChanges();
	}

	setAppearance(preference: AppearancePreference): void {
		this.preferenceState.set(preference);
		this.persistPreference(preference);
		this.applyAppearance();
	}

	private findStorage(): Storage | null {
		if (!this.view) {
			this.persistenceState.set(false);
			return null;
		}
		try {
			return this.view.localStorage;
		} catch {
			this.persistenceState.set(false);
			return null;
		}
	}

	private findColorScheme(): MediaQueryList | null {
		if (!this.view?.matchMedia) return null;
		try {
			return this.view.matchMedia('(prefers-color-scheme: dark)');
		} catch {
			return null;
		}
	}

	private readPreference(): AppearancePreference {
		if (!this.storage) return 'system';
		try {
			const preference = this.storage.getItem(APPEARANCE_STORAGE_KEY);
			return isAppearancePreference(preference) ? preference : 'system';
		} catch {
			this.persistenceState.set(false);
			return 'system';
		}
	}

	private persistPreference(preference: AppearancePreference): void {
		if (!this.storage) return;
		try {
			if (preference === 'system')
				this.storage.removeItem(APPEARANCE_STORAGE_KEY);
			else this.storage.setItem(APPEARANCE_STORAGE_KEY, preference);
			this.persistenceState.set(true);
		} catch {
			this.persistenceState.set(false);
		}
	}

	private listenForSystemChanges(): void {
		const colorScheme = this.colorScheme;
		if (!colorScheme || typeof colorScheme.addEventListener !== 'function')
			return;
		const listener = (event: MediaQueryListEvent): void => {
			this.systemDarkState.set(event.matches);
			if (this.preferenceState() === 'system') this.applyAppearance();
		};
		try {
			colorScheme.addEventListener('change', listener);
		} catch {
			return;
		}
		this.destroyRef.onDestroy(() =>
			colorScheme.removeEventListener('change', listener),
		);
	}

	private applyAppearance(): void {
		const root = this.document.documentElement;
		root.setAttribute('data-appearance-preference', this.preferenceState());
		root.setAttribute('data-appearance', this.resolved());
	}
}
