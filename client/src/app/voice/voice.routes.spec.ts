import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { CarStore } from '../car/car-store';
import { VOICE_ROUTES } from './voice.routes';

describe('voice route providers', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('constructs the selected-car store from the route injector', () => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				...(VOICE_ROUTES[0]?.providers ?? []),
			],
		});

		expect(() => TestBed.inject(CarStore)).not.toThrow();
	});
});
