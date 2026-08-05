import { Component } from '@angular/core';
import { Routes } from '@angular/router';
import { ownerSessionCanMatch } from './owner-session.guard';

@Component({ template: '' })
export class RoutedWorkspace {}

export const signInRoute = {
	path: 'sign-in',
	loadComponent: () => import('./sign-in').then(({ SignIn }) => SignIn),
};

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'garage' },
	signInRoute,
	{
		path: 'garage',
		pathMatch: 'full',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'garage/:carId/overview',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'garage/:carId/setups',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'garage/:carId/build',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'garage/:carId/photos',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'garage/:carId/runs',
		canMatch: [ownerSessionCanMatch],
		loadComponent: () => import('./garage/garage').then(({ Garage }) => Garage),
	},
	{
		path: 'maintenance',
		canMatch: [ownerSessionCanMatch],
		component: RoutedWorkspace,
	},
	{
		path: 'settings',
		canMatch: [ownerSessionCanMatch],
		component: RoutedWorkspace,
	},
	{ path: '**', redirectTo: 'garage' },
];
