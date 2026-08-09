import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VoiceConnectivity } from './voice-connectivity';

describe('VoiceConnectivity', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		TestBed.resetTestingModule();
	});

	it('reports browser connectivity and treats server rendering as online', () => {
		const connectivity = TestBed.inject(VoiceConnectivity);
		expect(connectivity.isOnline()).toBe(navigator.onLine);
		vi.stubGlobal('navigator', undefined);
		expect(connectivity.isOnline()).toBe(true);
	});
});
