import { Routes } from '@angular/router';
import { TrackMapGateway } from './track-map-gateway';
import { TrackMapStore } from './track-map-store';

export const TRACK_MAP_ROUTES: Routes = [
	{
		path: '',
		providers: [TrackMapGateway, TrackMapStore],
		loadComponent: () =>
			import('./track-maps').then(({ TrackMaps }) => TrackMaps),
	},
];
