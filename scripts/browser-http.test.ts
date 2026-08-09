import { describe, expect, test } from 'vitest';
import {
	forwardedHeaderPairs,
	forwardedIncomingHeaders,
	forwardedRawHeaders,
} from './browser-http';

describe('browser proxy headers', () => {
	test('strips hop-by-hop and connection-nominated raw headers', () => {
		const rawHeaders = [
			'Connection',
			'keep-alive, x-remove',
			'Keep-Alive',
			'timeout=5',
			'X-Remove',
			'private',
			'Transfer-Encoding',
			'chunked',
			'Content-Type',
			'application/json',
			'Set-Cookie',
			'first=1',
			'Set-Cookie',
			'second=2',
		];

		expect(forwardedHeaderPairs(rawHeaders)).toEqual([
			['Content-Type', 'application/json'],
			['Set-Cookie', 'first=1'],
			['Set-Cookie', 'second=2'],
		]);
		expect(forwardedRawHeaders(rawHeaders)).toEqual([
			'Content-Type',
			'application/json',
			'Set-Cookie',
			'first=1',
			'Set-Cookie',
			'second=2',
		]);
	});

	test('strips connection-specific incoming headers and keeps end-to-end values', () => {
		expect(
			forwardedIncomingHeaders({
				connection: 'upgrade, x-remove',
				host: '127.0.0.1:4201',
				upgrade: 'websocket',
				'x-remove': 'private',
				'x-request-id': 'request-1',
			}),
		).toEqual({
			host: '127.0.0.1:4201',
			'x-request-id': 'request-1',
		});
		expect(forwardedIncomingHeaders({ accept: 'text/html' })).toEqual({
			accept: 'text/html',
		});
	});

	test('ignores incomplete raw header pairs', () => {
		expect(
			forwardedHeaderPairs(['Accept', 'text/html', 'X-Incomplete']),
		).toEqual([['Accept', 'text/html']]);
	});
});
