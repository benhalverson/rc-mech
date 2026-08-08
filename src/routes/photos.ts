import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createPhotoCollectionRoutes } from './photos/photo-collection';
import { createPhotoItemRoutes } from './photos/photo-items';

export const createPhotosRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createPhotoCollectionRoutes())
		.route('/', createPhotoItemRoutes());
