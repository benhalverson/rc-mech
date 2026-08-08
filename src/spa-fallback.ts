import type { AppContext } from './types';

export const hasHiddenPathSegment = (pathname: string): boolean =>
	pathname.split('/').some((segment) => {
		let decoded = segment;
		for (let pass = 0; pass < 2; pass += 1) {
			try {
				const next = decodeURIComponent(decoded);
				if (next === decoded) break;
				decoded = next;
			} catch {
				break;
			}
		}
		return decoded.startsWith('.');
	});

export const spaFallback = async (c: AppContext) => {
	if (hasHiddenPathSegment(new URL(c.req.url).pathname))
		return c.text('Not found', 404);

	const response = await c.env.ASSETS.fetch(c.req.raw);
	if (
		response.status !== 404 ||
		c.req.method !== 'GET' ||
		!c.req.header('Accept')?.includes('text/html')
	)
		return response;
	return c.env.ASSETS.fetch(new Request(new URL('/', c.req.url), c.req.raw));
};
