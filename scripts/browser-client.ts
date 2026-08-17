import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import {
	createServer,
	type IncomingMessage,
	request as requestUpstream,
	type ServerResponse,
} from 'node:http';
import { extname, resolve, sep } from 'node:path';
import { hasHiddenPathSegment } from '../src/spa-fallback';
import { forwardedIncomingHeaders, forwardedRawHeaders } from './browser-http';

const hostname = '127.0.0.1';
const port = Number(process.env['RC_MECH_BROWSER_CLIENT_PORT'] ?? 4201);
const workerPort = Number(process.env['RC_MECH_BROWSER_WORKER_PORT'] ?? 8787);
const origin = `http://${hostname}:${port}`;
const publicRoot = resolve('public');
const contentTypes: Readonly<Record<string, string>> = {
	'.css': 'text/css; charset=utf-8',
	'.html': 'text/html; charset=utf-8',
	'.ico': 'image/x-icon',
	'.jpeg': 'image/jpeg',
	'.jpg': 'image/jpeg',
	'.js': 'text/javascript; charset=utf-8',
	'.json': 'application/json; charset=utf-8',
	'.map': 'application/json; charset=utf-8',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.webmanifest': 'application/manifest+json',
	'.webp': 'image/webp',
	'.woff2': 'font/woff2',
};

const proxyApi = (request: IncomingMessage, response: ServerResponse): void => {
	const headers = forwardedIncomingHeaders(request.headers);
	headers.host = `${hostname}:${workerPort}`;
	if (!headers.origin) headers.origin = origin;
	const upstream = requestUpstream(
		{
			hostname,
			port: workerPort,
			method: request.method,
			path: request.url,
			headers,
		},
		(upstreamResponse) => {
			response.writeHead(
				upstreamResponse.statusCode ?? 502,
				upstreamResponse.statusMessage,
				forwardedRawHeaders(upstreamResponse.rawHeaders),
			);
			upstreamResponse.once('error', (error) => response.destroy(error));
			response.once('close', () => {
				if (!upstreamResponse.complete) upstreamResponse.destroy();
			});
			upstreamResponse.pipe(response);
		},
	);

	request.once('aborted', () => upstream.destroy());
	upstream.once('error', () => {
		if (response.headersSent) {
			response.destroy();
			return;
		}
		response.writeHead(502, {
			'content-type': 'text/plain; charset=utf-8',
			'retry-after': '1',
		});
		response.end('The local browser Worker is not ready.');
	});
	request.pipe(upstream);
};

const staticPath = (pathname: string): string | undefined => {
	if (hasHiddenPathSegment(pathname)) return undefined;
	let decoded: string;
	try {
		decoded = decodeURIComponent(pathname);
	} catch {
		return undefined;
	}
	const candidate = resolve(publicRoot, `.${decoded}`);
	if (candidate !== publicRoot && !candidate.startsWith(`${publicRoot}${sep}`))
		return undefined;
	return candidate;
};

const serveFile = async (
	request: IncomingMessage,
	response: ServerResponse,
	path: string,
): Promise<boolean> => {
	try {
		const file = await stat(path);
		if (!file.isFile()) return false;
		response.writeHead(200, {
			'cache-control': 'no-cache',
			'content-length': file.size,
			'content-type':
				contentTypes[extname(path).toLowerCase()] ?? 'application/octet-stream',
		});
		if (request.method === 'HEAD') {
			response.end();
			return true;
		}
		const stream = createReadStream(path);
		request.once('aborted', () => stream.destroy());
		stream.once('error', (error) => response.destroy(error));
		stream.pipe(response);
		return true;
	} catch {
		return false;
	}
};

const serveClient = async (
	request: IncomingMessage,
	response: ServerResponse,
	pathname: string,
): Promise<void> => {
	const path = staticPath(pathname);
	if (!path) {
		response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
		response.end('Not found');
		return;
	}
	if (await serveFile(request, response, path)) return;
	if (
		request.method === 'GET' &&
		request.headers.accept?.includes('text/html') &&
		(await serveFile(request, response, resolve(publicRoot, 'index.html')))
	)
		return;
	response.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
	response.end('Not found');
};

const server = createServer((request, response) => {
	const pathname = new URL(request.url ?? '/', origin).pathname;
	if (pathname === '/api' || pathname.startsWith('/api/')) {
		proxyApi(request, response);
		return;
	}
	void serveClient(request, response, pathname);
});

await new Promise<void>((resolve, reject) => {
	server.once('error', reject);
	server.listen(port, hostname, resolve);
});

let closing = false;
const close = (): void => {
	if (closing) return;
	closing = true;
	server.closeAllConnections();
	server.close(() => {
		process.exitCode = 0;
	});
};

process.once('SIGINT', close);
process.once('SIGTERM', close);
