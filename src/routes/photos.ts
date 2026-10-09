import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createPhotoCaptureRoutes } from './photos/photo-capture';
import { createPhotoCollectionRoutes } from './photos/photo-collection';
import { createPhotoItemRoutes } from './photos/photo-items';

export const createPhotosRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createPhotoCaptureRoutes())
		.route('/', createPhotoCollectionRoutes())
		.route('/', createPhotoItemRoutes());
