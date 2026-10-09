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

const withNoIndex = (response: Response): Response => {
	const headers = new Headers(response.headers);
	headers.set('X-Robots-Tag', 'noindex');
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
};

export const spaFallback = async (c: AppContext) => {
	const pathname = new URL(c.req.url).pathname;
	if (hasHiddenPathSegment(pathname)) return c.text('Not found', 404);

	const response = await c.env.ASSETS.fetch(c.req.raw);
	if (
		response.status !== 404 ||
		c.req.method !== 'GET' ||
		!c.req.header('Accept')?.includes('text/html')
	)
		return response;

	const fallback = await c.env.ASSETS.fetch(
		new Request(new URL('/', c.req.url), c.req.raw),
	);
	return pathname === '/' ? fallback : withNoIndex(fallback);
};
