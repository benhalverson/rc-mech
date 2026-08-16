import { Component } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter, Router } from '@angular/router';
import { RouterTestingHarness } from '@angular/router/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes, workspaceBoundaryRoute } from './app.routes';
import {
	protectedWorkspaceRoute,
	workspaceRoutes,
} from './shell/workspace.routes';

// Route tests verify lazy wiring; component specs and the production build
// exercise Lucide without evaluating its 12 MB barrel in this architecture test.
vi.mock('@lucide/angular', () => ({
	LucideArchive: class {},
	LucideArchiveRestore: class {},
	LucideCheck: class {},
	LucideCheckCircle2: class {},
	LucideCircleCheck: class {},
	LucideCarFront: class {},
	LucideChevronRight: class {},
	LucideClock: class {},
	LucideClipboardCopy: class {},
	LucideClipboardList: class {},
	LucideCopy: class {},
	LucideExternalLink: class {},
	LucideFileInput: class {},
	LucideImage: class {},
	LucideHistory: class {},
	LucideKeyRound: class {},
	LucideMic: class {},
	LucideMonitor: class {},
	LucideMoveDown: class {},
	LucideMoveUp: class {},
	LucideMoon: class {},
	LucidePencil: class {},
	LucidePause: class {},
	LucidePlay: class {},
	LucidePlus: class {},
	LucideRefreshCw: class {},
	LucideRepeat2: class {},
	LucideRotateCw: class {},
	LucideRotateCcw: class {},
	LucideSave: class {},
	LucideStar: class {},
	LucideSun: class {},
	LucideTrash2: class {},
	LucideTriangleAlert: class {},
	LucideUpload: class {},
	LucideWrench: class {},
	LucideX: class {},
}));

@Component({ template: '' })
class RedirectTarget {}

afterEach(() => TestBed.resetTestingModule());

describe('application routes', () => {
	it('lazy-loads the public root independently of session-aware code', async () => {
		const landing = routes[0];
		expect(landing?.path).toBe('');
		expect(landing?.pathMatch).toBe('full');
		expect(landing?.canMatch).toBeUndefined();
		expect(landing?.loadChildren).toBeTypeOf('function');

		const landingRoutes = await landing?.loadChildren?.();
		expect(Array.isArray(landingRoutes)).toBe(true);
		if (!Array.isArray(landingRoutes)) return;
		expect(landingRoutes[0]?.providers).toBeUndefined();
		expect(await landingRoutes[0]?.loadComponent?.()).toBeTypeOf('function');
	});

	it('guards one lazy authenticated shell before resolving workspace children', async () => {
		expect(workspaceBoundaryRoute.canMatch).toBeUndefined();
		expect(workspaceBoundaryRoute.loadComponent).toBeUndefined();
		expect(workspaceBoundaryRoute.loadChildren).toBeTypeOf('function');
		expect(await workspaceBoundaryRoute.loadChildren?.()).toEqual([
			protectedWorkspaceRoute,
		]);
		expect(protectedWorkspaceRoute.canMatch).toHaveLength(1);
		expect(protectedWorkspaceRoute.loadComponent).toBeTypeOf('function');
		expect(protectedWorkspaceRoute.children).toBe(workspaceRoutes);
		expect(await protectedWorkspaceRoute.loadComponent?.()).toBeTypeOf(
			'function',
		);
		for (const route of workspaceRoutes) expect(route.canMatch).toBeUndefined();
	});

	it('keeps Garage collection and overview independently route scoped', () => {
		const collection = workspaceRoutes.find((route) => route.path === 'garage');
		const overview = workspaceRoutes.find(
			(route) => route.path === 'garage/:carId/overview',
		);

		expect(collection?.pathMatch).toBe('full');
		expect(collection?.loadChildren).toBeTypeOf('function');
		expect(overview?.loadChildren).not.toBe(collection?.loadChildren);
		expect(overview?.providers).toBeUndefined();
	});

	it('gives every car leaf its own lazy route boundary', () => {
		const carRoutes = workspaceRoutes.filter(
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
			expect(route.loadChildren).toBeTypeOf('function');
			expect(route.providers).toBeUndefined();
		}
	});

	it('keeps the legacy Drive-session URL as a preserving redirect inside the guarded shell', async () => {
		const legacyRoute = workspaceRoutes.find(
			(route) => route.path === 'garage/:carId/runs',
		);
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
		for (const route of workspaceRoutes.filter((candidate) =>
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

	it('keeps public authentication behind its own lazy route boundary', async () => {
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

	it('loads Settings and Maintenance through separate lazy route files', () => {
		const settings = workspaceRoutes.find((route) => route.path === 'settings');
		const maintenance = workspaceRoutes.find(
			(route) => route.path === 'maintenance',
		);

		expect(settings?.loadChildren).toBeTypeOf('function');
		expect(settings?.loadComponent).toBeUndefined();
		expect(maintenance?.loadChildren).toBeTypeOf('function');
		expect(maintenance?.loadComponent).toBeUndefined();
	});
});
