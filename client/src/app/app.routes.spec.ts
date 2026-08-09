import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { routes } from './app.routes';

@Component({ template: '' })
class RedirectTarget {}

afterEach(() => TestBed.resetTestingModule());

describe('protected workspace routes', () => {
	it('lazy-loads Garage behind an owner canMatch gate', () => {
		const garage = routes.find((route) => route.path === 'garage');

		expect(garage?.canMatch).toHaveLength(1);
		expect(garage?.loadChildren).toBeTypeOf('function');
		expect(garage?.component).toBeUndefined();
		expect(garage?.providers).toBeUndefined();
	});

	it('keeps collection and overview independently route scoped', () => {
		const collection = routes.find((route) => route.path === 'garage');
		const overview = routes.find(
			(route) => route.path === 'garage/:carId/overview',
		);

		expect(overview?.loadChildren).not.toBe(collection?.loadChildren);
		expect(overview?.providers).toBeUndefined();
		expect(overview?.canMatch).toHaveLength(1);
	});

	it('gives every car leaf its own protected lazy route boundary', () => {
		const carRoutes = routes.filter(
			(route) => route.path?.startsWith('garage/:carId/') && route.loadChildren,
		);

		expect(carRoutes.map((route) => route.path)).toEqual([
			'garage/:carId/overview',
			'garage/:carId/setups',
			'garage/:carId/build',
			'garage/:carId/photos',
			'garage/:carId/drive-sessions',
			'garage/:carId/voice',
		]);
		expect(new Set(carRoutes.map((route) => route.loadChildren)).size).toBe(6);
		for (const route of carRoutes) {
			expect(route.canMatch).toHaveLength(1);
			expect(route.loadChildren).toBeTypeOf('function');
			expect(route.providers).toBeUndefined();
		}
	});

	it('keeps the legacy Drive-session URL as a preserving redirect to the protected canonical route', async () => {
		const legacyRoute = routes.find(
			(route) => route.path === 'garage/:carId/runs',
		);
		expect(legacyRoute?.canMatch).toBeUndefined();
		expect(
			routes.find((route) => route.path === 'garage/:carId/drive-sessions')
				?.canMatch,
		).toHaveLength(1);
		expect(legacyRoute?.pathMatch).toBe('full');
		expect(legacyRoute?.redirectTo).toBeTypeOf('function');

		await TestBed.configureTestingModule({
			imports: [RedirectTarget],
			providers: [
				provideRouter([
					{ ...legacyRoute },
					{
						path: 'garage/:carId/drive-sessions',
						component: RedirectTarget,
					},
				]),
			],
		}).compileComponents();
		const harness = await RouterTestingHarness.create();
		await harness.navigateByUrl(
			'/garage/car%2Fone/runs?source=bookmark&filter=archived#session-2',
		);

		expect(TestBed.inject(Router).url).toBe(
			'/garage/car%2Fone/drive-sessions?source=bookmark&filter=archived#session-2',
		);
		await harness.navigateByUrl('/garage/car-2/runs');
		expect(TestBed.inject(Router).url).toBe('/garage/car-2/drive-sessions');
	});

	it('keeps feature stores beside lazy leaf components', async () => {
		for (const route of routes.filter(
			(candidate) =>
				(candidate.path === 'garage' ||
					candidate.path?.startsWith('garage/:carId/')) &&
				Boolean(candidate.loadChildren),
		)) {
			const lazyRoutes = await route.loadChildren?.();
			expect(Array.isArray(lazyRoutes)).toBe(true);
			if (!Array.isArray(lazyRoutes)) continue;
			expect(lazyRoutes[0]?.providers).toBeDefined();
			expect(lazyRoutes[0]?.loadComponent).toBeTypeOf('function');
			expect(await lazyRoutes[0]?.loadComponent?.()).toBeTypeOf('function');
		}
	});

	it('resolves every top-level lazy route boundary', async () => {
		for (const route of routes) {
			if (route.loadComponent)
				expect(await route.loadComponent()).toBeTypeOf('function');
			if (route.loadChildren) {
				const lazyRoutes = await route.loadChildren();
				expect(Array.isArray(lazyRoutes)).toBe(true);
				if (Array.isArray(lazyRoutes)) {
					for (const lazyRoute of lazyRoutes) {
						if (lazyRoute.loadComponent)
							expect(await lazyRoute.loadComponent()).toBeTypeOf('function');
					}
				}
			}
		}
	});

	it('keeps the public authentication workflow behind its own lazy route boundary', async () => {
		const signIn = routes.find((route) => route.path === 'sign-in');
		expect(signIn?.loadChildren).toBeTypeOf('function');
		expect(signIn?.loadComponent).toBeUndefined();
		expect(signIn?.providers).toBeUndefined();

		const authenticationRoutes = await signIn?.loadChildren?.();
		expect(Array.isArray(authenticationRoutes)).toBe(true);
		if (!Array.isArray(authenticationRoutes)) return;
		expect(authenticationRoutes[0]?.providers).toHaveLength(3);
		expect(authenticationRoutes[0]?.loadComponent).toBeTypeOf('function');
		expect(await authenticationRoutes[0]?.loadComponent?.()).toBeTypeOf(
			'function',
		);
	});

	it('keeps every protected workspace behind the session gate', () => {
		for (const route of routes.filter(
			(candidate) =>
				(candidate.path?.startsWith('garage') && !candidate.redirectTo) ||
				['maintenance', 'settings'].includes(candidate.path ?? ''),
		)) {
			expect(route.canMatch).toHaveLength(1);
			expect(
				route.loadComponent ?? route.loadChildren ?? route.redirectTo,
			).toBeTypeOf('function');
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
