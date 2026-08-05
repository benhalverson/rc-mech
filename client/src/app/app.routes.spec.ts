import { describe, expect, it } from 'vitest';
import { routes } from './app.routes';

describe('protected workspace routes', () => {
	it('lazy-loads Garage behind an owner canMatch gate', () => {
		const garage = routes.find((route) => route.path === 'garage');

		expect(garage?.canMatch).toHaveLength(1);
		expect(garage?.loadComponent).toBeTypeOf('function');
		expect(garage?.component).toBeUndefined();
	});

	it('keeps a public sign-in route available for rejected navigation', () => {
		expect(routes.some((route) => route.path === 'sign-in')).toBe(true);
	});
});
