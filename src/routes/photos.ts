import { Hono } from 'hono';
import type { AppEnv } from '../types';
import { createPhotoCaptureRoutes } from './photos/photo-capture';
import { createPhotoChangeRoutes } from './photos/photo-change';
import { createPhotoCollectionRoutes } from './photos/photo-collection';
import { createPhotoItemRoutes } from './photos/photo-items';

export const createPhotosRoutes = () =>
	new Hono<AppEnv>()
		.route('/', createPhotoCaptureRoutes())
		.route('/', createPhotoChangeRoutes())
		.route('/', createPhotoCollectionRoutes())
		.route('/', createPhotoItemRoutes());
