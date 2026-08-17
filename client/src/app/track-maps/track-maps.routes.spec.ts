import { describe, expect, it } from 'vitest';
import { TRACK_MAP_ROUTES } from './track-maps.routes';

describe('Track-map routes', () => {
	it('keeps the owner editor lazy and route-provided', async () => {
		const route = TRACK_MAP_ROUTES[0];
		expect(route.path).toBe('');
		expect(route.providers).toHaveLength(2);
		expect(await route.loadComponent?.()).toBeTypeOf('function');
	});
});
