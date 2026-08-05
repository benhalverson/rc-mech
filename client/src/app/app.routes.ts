import { Component } from '@angular/core';
import { Routes } from '@angular/router';

@Component({ standalone: true, template: '' })
export class RoutedWorkspace {}

export const routes: Routes = [
	{ path: '', pathMatch: 'full', redirectTo: 'garage' },
	{ path: 'garage', pathMatch: 'full', component: RoutedWorkspace },
	{ path: 'garage/:carId/overview', component: RoutedWorkspace },
	{ path: 'garage/:carId/setups', component: RoutedWorkspace },
	{ path: 'garage/:carId/build', component: RoutedWorkspace },
	{ path: 'garage/:carId/photos', component: RoutedWorkspace },
	{ path: 'garage/:carId/runs', component: RoutedWorkspace },
	{ path: 'maintenance', component: RoutedWorkspace },
	{ path: 'settings', component: RoutedWorkspace },
	{ path: '**', redirectTo: 'garage' },
];
