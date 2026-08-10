import { TestBed } from '@angular/core/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { LANDING_ROUTES } from './landing.routes';

afterEach(() => TestBed.resetTestingModule());

describe('LANDING_ROUTES', () => {
	it('lazy-loads the static landing component without providers', async () => {
		const route = LANDING_ROUTES[0];
		expect(route?.path).toBe('');
		expect(route?.providers).toBeUndefined();
		expect(route?.loadComponent).toBeTypeOf('function');
		expect(await route?.loadComponent?.()).toBeTypeOf('function');
	});
});
