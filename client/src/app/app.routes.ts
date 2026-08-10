import type { Route, Routes } from '@angular/router';

const loadLandingRoutes = () =>
	import('./landing/landing.routes').then(
		({ LANDING_ROUTES }) => LANDING_ROUTES,
	);
const loadSignInRoutes = () =>
	import('./sign-in/sign-in.routes').then(
		({ SIGN_IN_ROUTES }) => SIGN_IN_ROUTES,
	);
const loadWorkspaceRoutes = () =>
	import('./shell/workspace.routes').then(
		({ WORKSPACE_ROUTES }) => WORKSPACE_ROUTES,
	);

export const signInRoute: Route = {
	path: 'sign-in',
	loadChildren: loadSignInRoutes,
};

export const workspaceBoundaryRoute: Route = {
	path: '',
	loadChildren: loadWorkspaceRoutes,
};

export const routes: Routes = [
	{ path: '', pathMatch: 'full', loadChildren: loadLandingRoutes },
	signInRoute,
	workspaceBoundaryRoute,
	{ path: '**', redirectTo: 'garage' },
];
