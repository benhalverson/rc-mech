import type { IncomingHttpHeaders, OutgoingHttpHeaders } from 'node:http';

const hopByHopHeaders = new Set([
	'connection',
	'keep-alive',
	'proxy-authenticate',
	'proxy-authorization',
	'te',
	'trailer',
	'transfer-encoding',
	'upgrade',
]);

const connectionTokens = (values: readonly string[]): Set<string> => {
	const excluded = new Set(hopByHopHeaders);
	for (const value of values) {
		for (const token of value.split(',')) {
			const normalized = token.trim().toLowerCase();
			if (normalized) excluded.add(normalized);
		}
	}
	return excluded;
};

const rawConnectionValues = (rawHeaders: readonly string[]): string[] => {
	const values: string[] = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		if (rawHeaders[index]?.toLowerCase() === 'connection') {
			const value = rawHeaders[index + 1];
			if (value) values.push(value);
		}
	}
	return values;
};

export const forwardedHeaderPairs = (
	rawHeaders: readonly string[],
): Array<[string, string]> => {
	const excluded = connectionTokens(rawConnectionValues(rawHeaders));
	const headers: Array<[string, string]> = [];
	for (let index = 0; index < rawHeaders.length; index += 2) {
		const name = rawHeaders[index];
		const value = rawHeaders[index + 1];
		if (name && value && !excluded.has(name.toLowerCase()))
			headers.push([name, value]);
	}
	return headers;
};

export const forwardedRawHeaders = (rawHeaders: readonly string[]): string[] =>
	forwardedHeaderPairs(rawHeaders).flat();

export const forwardedIncomingHeaders = (
	headers: IncomingHttpHeaders,
): OutgoingHttpHeaders => {
	const connection = headers.connection;
	const excluded = connectionTokens(
		Array.isArray(connection) ? connection : connection ? [connection] : [],
	);
	const forwarded: OutgoingHttpHeaders = {};
	for (const [name, value] of Object.entries(headers)) {
		if (!excluded.has(name.toLowerCase())) forwarded[name] = value;
	}
	return forwarded;
};
