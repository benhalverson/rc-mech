import { describe, expect, it } from 'vitest';
import { routes } from './app.routes';

describe('protected workspace routes', () => {
	it('lazy-loads Garage behind an owner canMatch gate', () => {
		const garage = routes.find((route) => route.path === 'garage');

		expect(garage?.canMatch).toHaveLength(1);
		expect(garage?.loadComponent).toBeTypeOf('function');
		expect(garage?.component).toBeUndefined();
		expect(garage?.providers).toBeDefined();
	});

	it('keeps collection and overview on the same route-scoped Garage feature', () => {
		const collection = routes.find((route) => route.path === 'garage');
		const overview = routes.find(
			(route) => route.path === 'garage/:carId/overview',
		);

		expect(overview?.loadComponent).toBe(collection?.loadComponent);
		expect(overview?.providers).toBeDefined();
		expect(overview?.canMatch).toHaveLength(1);
	});

	it('keeps a public sign-in route available for rejected navigation', () => {
		expect(routes.some((route) => route.path === 'sign-in')).toBe(true);
	});

	it('keeps every protected workspace behind the session gate', () => {
		for (const route of routes.filter((candidate) =>
			['garage', 'maintenance', 'settings'].includes(candidate.path ?? ''),
		)) {
			expect(route.canMatch).toHaveLength(1);
			expect(route.loadComponent ?? route.loadChildren).toBeTypeOf('function');
		}
	});

	it('loads Settings through its own lazy route file', () => {
		const settings = routes.find((route) => route.path === 'settings');

		expect(settings?.canMatch).toHaveLength(1);
		expect(settings?.loadChildren).toBeTypeOf('function');
		expect(settings?.loadComponent).toBeUndefined();
	});

	it('loads Maintenance through its own lazy route file', () => {
		const maintenance = routes.find((route) => route.path === 'maintenance');

		expect(maintenance?.canMatch).toHaveLength(1);
		expect(maintenance?.loadChildren).toBeTypeOf('function');
		expect(maintenance?.loadComponent).toBeUndefined();
	});
});
