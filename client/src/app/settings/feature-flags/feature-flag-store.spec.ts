import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VisibilityStore } from '../../driving-analysis-visibility/visibility-store';
import { OwnerSessionStore } from '../../owner-session-store';
import { FeatureFlagGateway } from './feature-flag-gateway';
import { FeatureFlagStore } from './feature-flag-store';

describe('FeatureFlagStore', () => {
	const sessionKey = signal<string | null>('owner');
	const isOwner = signal(true);
	const setting = signal<boolean | null>(false);
	let response: Subject<{ enabled: boolean }>;
	let store: InstanceType<typeof FeatureFlagStore>;
	const save = vi.fn();
	beforeEach(() => {
		sessionKey.set('owner');
		isOwner.set(true);
		setting.set(false);
		response = new Subject();
		save.mockReset().mockReturnValue(response);
		TestBed.configureTestingModule({
			providers: [
				FeatureFlagStore,
				{ provide: OwnerSessionStore, useValue: { sessionKey } },
				{ provide: VisibilityStore, useValue: { isOwner, setting } },
				{ provide: FeatureFlagGateway, useValue: { save } },
			],
		});
		store = TestBed.inject(FeatureFlagStore);
	});
	afterEach(() => TestBed.resetTestingModule());
	it('retains confirmed data while saving and publishes acknowledgement without changing visibility', () => {
		expect(store.enabled()).toBe(false);
		expect(store.status()).toBe('idle');
		store.save({ enabled: true });
		expect(store.status()).toBe('pending');
		expect(store.enabled()).toBe(false);
		store.save({ enabled: false });
		expect(save).toHaveBeenCalledExactlyOnceWith({ enabled: true });
		response.next({ enabled: true });
		response.complete();
		expect(store.status()).toBe('succeeded');
		expect(store.enabled()).toBe(true);
		expect(setting()).toBe(false);
	});
	it('reports failed saves without changing the saved value', () => {
		store.save({ enabled: true });
		response.error(new Error('failed'));
		expect(store.status()).toBe('failed');
		expect(store.enabled()).toBe(false);
	});
	it.each(['success', 'error'])(
		'ignores a previous session completion: %s',
		(completion) => {
			store.save({ enabled: true });
			sessionKey.set('user');
			isOwner.set(false);
			expect(store.enabled()).toBeNull();
			expect(store.status()).toBe('idle');
			if (completion === 'success') response.next({ enabled: true });
			else response.error(new Error('old failure'));
			expect(store.enabled()).toBeNull();
			expect(store.status()).toBe('idle');
		},
	);
	it('does not save without a session, Owner verification, or a known setting', () => {
		sessionKey.set(null);
		store.save({ enabled: true });
		sessionKey.set('user');
		isOwner.set(false);
		store.save({ enabled: true });
		isOwner.set(true);
		setting.set(null);
		store.save({ enabled: true });
		expect(save).not.toHaveBeenCalled();
	});

	it('cancels a prior session save and immediately accepts the replacement Owner command', () => {
		store.save({ enabled: true });
		expect(response.observed).toBe(true);
		sessionKey.set('next-owner');
		const next = new Subject<{ enabled: boolean }>();
		save.mockReturnValue(next);
		store.save({ enabled: true });
		expect(response.observed).toBe(false);
		expect(save).toHaveBeenCalledTimes(2);
		expect(store.status()).toBe('pending');
		next.next({ enabled: true });
		expect(store.enabled()).toBe(true);
	});

	it('cancels a pending write on sign-out even without another command', () => {
		store.save({ enabled: true });
		TestBed.tick();
		expect(response.observed).toBe(true);
		sessionKey.set(null);
		TestBed.tick();
		expect(response.observed).toBe(false);
		expect(store.status()).toBe('idle');
	});
});
