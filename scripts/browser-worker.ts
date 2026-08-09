import {
	createServer,
	type IncomingMessage,
	type ServerResponse,
} from 'node:http';
import { createTestHarness } from 'wrangler';
import { forwardedHeaderPairs } from './browser-http';

const hostname = '127.0.0.1';
const port = 8787;
const origin = `http://${hostname}:${port}`;

const harness = createTestHarness({
	root: process.cwd(),
	workers: [
		{
			configPath: './wrangler.browser.jsonc',
			vars: {
				APP_URL: origin,
				MAGIC_LINK_TEST_TOKEN: 'local-test-token',
				OWNER_EMAIL: 'owner@example.com',
			},
		},
	],
});

const requestHeaders = (request: IncomingMessage): Array<[string, string]> =>
	forwardedHeaderPairs(request.rawHeaders);

const requestBody = async (
	request: IncomingMessage,
): Promise<Uint8Array | undefined> => {
	if (request.method === 'GET' || request.method === 'HEAD') return undefined;
	const chunks: Uint8Array[] = [];
	for await (const chunk of request) {
		chunks.push(
			typeof chunk === 'string' ? Buffer.from(chunk) : new Uint8Array(chunk),
		);
	}
	return Buffer.concat(chunks);
};

const writeResponse = async (
	response: Awaited<ReturnType<typeof harness.fetch>>,
	target: ServerResponse,
	signal: AbortSignal,
): Promise<void> => {
	target.statusCode = response.status;
	target.statusMessage = response.statusText;
	const rawHeaders = Array.from(response.headers, ([name, value]) => [
		name,
		value,
	]).flat();
	for (const [name, value] of forwardedHeaderPairs(rawHeaders)) {
		if (name !== 'set-cookie') target.setHeader(name, value);
	}
	const cookies = response.headers.getSetCookie();
	if (cookies.length) target.setHeader('set-cookie', cookies);
	if (!response.body) {
		target.end();
		return;
	}

	const reader = response.body.getReader();
	const waitForDrain = (): Promise<void> =>
		new Promise((resolve, reject) => {
			const cleanup = (): void => {
				target.off('drain', drained);
				target.off('close', closed);
				signal.removeEventListener('abort', closed);
			};
			const drained = (): void => {
				cleanup();
				resolve();
			};
			const closed = (): void => {
				cleanup();
				reject(new Error('The browser response was closed.'));
			};
			target.once('drain', drained);
			target.once('close', closed);
			signal.addEventListener('abort', closed, { once: true });
		});
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!target.write(value)) await waitForDrain();
		}
		target.end();
	} catch (error) {
		if (!target.destroyed)
			target.destroy(error instanceof Error ? error : new Error(String(error)));
	} finally {
		if (signal.aborted) await reader.cancel().catch(() => undefined);
		reader.releaseLock();
	}
};

await harness.listen();
await harness.getWorker().applyD1Migrations('DB');

const server = createServer(async (request, response) => {
	const controller = new AbortController();
	request.once('aborted', () => controller.abort());
	response.once('close', () => {
		if (!response.writableEnded) controller.abort();
	});
	try {
		const body = await requestBody(request);
		const upstream = await harness.fetch(
			new URL(request.url ?? '/', origin).href,
			{
				method: request.method,
				headers: requestHeaders(request),
				redirect: 'manual',
				signal: controller.signal,
				...(body ? { body } : {}),
			},
		);
		await writeResponse(upstream, response, controller.signal);
	} catch (error) {
		if (response.headersSent) {
			if (!response.destroyed)
				response.destroy(
					error instanceof Error ? error : new Error(String(error)),
				);
			return;
		}
		response.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
		response.end('The local browser Worker could not complete the request.');
	}
});

await new Promise<void>((resolve, reject) => {
	server.once('error', reject);
	server.listen(port, hostname, resolve);
});

let closing = false;
const close = async (exitCode: number): Promise<void> => {
	if (closing) return;
	closing = true;
	server.closeAllConnections();
	await new Promise<void>((resolve) => server.close(() => resolve()));
	await harness.close();
	process.exitCode = exitCode;
};

process.once('SIGINT', () => void close(0));
process.once('SIGTERM', () => void close(0));
