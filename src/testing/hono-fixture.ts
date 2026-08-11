import { expect } from 'vitest';
import { type AppDependencies, createApp } from '../index';
import type { VoiceProcessor } from '../voice-processing';

const D1_META: D1Meta & Record<string, unknown> = {
	duration: 0,
	size_after: 0,
	rows_read: 0,
	rows_written: 0,
	last_row_id: 0,
	changed_db: false,
	changes: 0,
};

const d1Result = <T>(results: T[]): D1Result<T> => ({
	success: true,
	meta: D1_META,
	results,
});

const camelCase = (value: string): string =>
	value.replace(/_([a-z])/g, (_match, letter: string) => letter.toUpperCase());

const selectedKeys = (query: string): readonly string[] | null => {
	const selection =
		/^select\s+(.+?)\s+from\s/is.exec(query)?.[1] ??
		/\sreturning\s+(.+)$/is.exec(query)?.[1];
	if (!selection) return null;
	const expressions = selection.split(', ');
	const keys = expressions.map((expression) => {
		const alias = /\s+as\s+"([^"]+)"\s*$/i.exec(expression)?.[1];
		if (alias) return alias;
		const quoted = [...expression.matchAll(/"([^"]+)"/g)];
		return quoted.at(-1)?.[1] ?? null;
	});
	return keys.every((key): key is string => key !== null) ? keys : null;
};

const rawRow = (
	query: string,
	row: Readonly<Record<string, unknown>>,
): readonly unknown[] => {
	const keys = selectedKeys(query);
	if (!keys) return Object.values(row);
	const resolved = keys.map((key) => {
		if (key in row) return row[key];
		return row[camelCase(key)];
	});
	return keys.some((key) => key in row || camelCase(key) in row)
		? resolved
		: Object.values(row);
};

export type D1Step =
	| { kind: 'first'; value: Record<string, unknown> | null }
	| { kind: 'all'; rows: readonly Record<string, unknown>[] }
	| { kind: 'run'; rows?: readonly Record<string, unknown>[] }
	| { kind: 'batch'; rows?: readonly (readonly Record<string, unknown>[])[] }
	| { kind: 'error'; error: unknown };

export type RecordedD1Query = {
	query: string;
	values: unknown[];
	operation: Exclude<D1Step['kind'], 'error'>;
};

export class MockD1Controller {
	readonly queries: RecordedD1Query[] = [];
	readonly batches: string[][] = [];
	readonly database: D1Database;
	#steps: D1Step[] = [];
	readonly #queryByStatement = new WeakMap<D1PreparedStatement, string>();

	constructor() {
		this.database = this.#database();
	}

	queue(...steps: D1Step[]): void {
		this.#steps.push(...steps);
	}

	expectConsumed(): void {
		expect(this.#steps).toEqual([]);
	}

	#take(kind: RecordedD1Query['operation']): D1Step {
		const step = this.#steps.shift();
		if (!step) throw new Error(`Unexpected D1 ${kind} call`);
		if (step.kind === 'error') throw step.error;
		if (step.kind !== kind)
			throw new Error(`Expected D1 ${step.kind} call, received ${kind}`);
		return step;
	}

	#statement(query: string): D1PreparedStatement {
		let values: unknown[] = [];
		const record = (operation: RecordedD1Query['operation']) => {
			this.queries.push({ query, values, operation });
			return this.#take(operation);
		};
		const statement: D1PreparedStatement = {
			bind: (...nextValues) => {
				values = nextValues;
				return statement;
			},
			first: async <T = Record<string, unknown>>() => {
				const step = record('first');
				return (step.kind === 'first' ? step.value : null) as T | null;
			},
			run: async <T = Record<string, unknown>>() => {
				const step = record('run');
				return d1Result([
					...((step.kind === 'run' ? step.rows : undefined) ?? []),
				]) as D1Result<T>;
			},
			all: async <T = Record<string, unknown>>() => {
				const step = record('all');
				return d1Result(
					step.kind === 'all' ? [...step.rows] : [],
				) as D1Result<T>;
			},
			raw: (async () => {
				const step = this.#steps.shift();
				if (!step) throw new Error('Unexpected D1 raw call');
				if (step.kind === 'error') throw step.error;
				if (step.kind !== 'first' && step.kind !== 'all')
					throw new Error(
						`Expected D1 ${step.kind} call, received raw selection`,
					);
				this.queries.push({ query, values, operation: step.kind });
				const rows =
					step.kind === 'first' ? (step.value ? [step.value] : []) : step.rows;
				return rows.map((row) => rawRow(query, row));
			}) as D1PreparedStatement['raw'],
		};
		this.#queryByStatement.set(statement, query);
		return statement;
	}

	#database(): D1Database {
		const prepare = (query: string) => this.#statement(query);
		const batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
			this.batches.push(
				statements.map(
					(statement) => this.#queryByStatement.get(statement) ?? '<unknown>',
				),
			);
			this.queries.push({ query: '<batch>', values: [], operation: 'batch' });
			const step = this.#take('batch');
			const rows = step.kind === 'batch' ? step.rows : undefined;
			return statements.map((_, index) =>
				d1Result((rows?.[index] ?? []) as T[]),
			);
		};
		const session: D1DatabaseSession = {
			prepare,
			batch,
			getBookmark: () => null,
		};
		return {
			prepare,
			batch,
			exec: async () => ({ count: 0, duration: 0 }),
			withSession: () => session,
			dump: async () => new ArrayBuffer(0),
		};
	}
}

type StoredR2Object = {
	bytes: Uint8Array;
	httpMetadata?: R2HTTPMetadata;
	customMetadata?: Record<string, string>;
};

const checksums: R2Checksums = { toJSON: () => ({}) };

const bytesFor = async (
	value: ReadableStream | ArrayBuffer | ArrayBufferView | string | null | Blob,
): Promise<Uint8Array> => {
	if (value === null) return new Uint8Array();
	if (typeof value === 'string') return new TextEncoder().encode(value);
	if (value instanceof Blob) return new Uint8Array(await value.arrayBuffer());
	if (value instanceof ReadableStream)
		return new Uint8Array(await new Response(value).arrayBuffer());
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
};

export class MockR2Controller {
	readonly objects = new Map<string, StoredR2Object>();
	readonly bucket: R2Bucket;

	constructor() {
		const objectFor = (key: string, stored: StoredR2Object): R2ObjectBody => {
			let bodyUsed = false;
			const copy = () => stored.bytes.slice();
			return {
				key,
				version: 'test-version',
				size: stored.bytes.byteLength,
				etag: 'test-etag',
				httpEtag: '"test-etag"',
				checksums,
				uploaded: new Date('2026-01-01T00:00:00.000Z'),
				httpMetadata: stored.httpMetadata,
				customMetadata: stored.customMetadata,
				storageClass: 'Standard',
				writeHttpMetadata(headers) {
					if (stored.httpMetadata?.contentType)
						headers.set('content-type', stored.httpMetadata.contentType);
				},
				get body() {
					bodyUsed = true;
					return new Blob([copy()]).stream();
				},
				get bodyUsed() {
					return bodyUsed;
				},
				arrayBuffer: async () => copy().buffer,
				bytes: async () => copy(),
				text: async () => new TextDecoder().decode(copy()),
				json: async <T>() => JSON.parse(new TextDecoder().decode(copy())) as T,
				blob: async () => new Blob([copy()]),
			};
		};

		async function put(
			this: MockR2Controller,
			key: string,
			value:
				| ReadableStream
				| ArrayBuffer
				| ArrayBufferView
				| string
				| null
				| Blob,
			options?: R2PutOptions,
		): Promise<R2Object> {
			const httpMetadata =
				options?.httpMetadata instanceof Headers
					? {
							contentType:
								options.httpMetadata.get('content-type') ?? undefined,
						}
					: options?.httpMetadata;
			const stored = {
				bytes: await bytesFor(value),
				httpMetadata,
				customMetadata: options?.customMetadata,
			};
			this.objects.set(key, stored);
			return objectFor(key, stored);
		}

		async function get(
			this: MockR2Controller,
			key: string,
		): Promise<R2ObjectBody | null> {
			const stored = this.objects.get(key);
			return stored ? objectFor(key, stored) : null;
		}

		const multipart = (key: string, uploadId: string): R2MultipartUpload => ({
			key,
			uploadId,
			uploadPart: async (partNumber) => ({ partNumber, etag: 'test-etag' }),
			abort: async () => undefined,
			complete: async () => {
				const stored = { bytes: new Uint8Array() };
				this.objects.set(key, stored);
				return objectFor(key, stored);
			},
		});

		this.bucket = {
			head: async (key) => {
				const stored = this.objects.get(key);
				return stored ? objectFor(key, stored) : null;
			},
			get: get.bind(this),
			put: put.bind(this),
			createMultipartUpload: async (key) => multipart(key, 'test-upload'),
			resumeMultipartUpload: multipart,
			delete: async (keys) => {
				for (const key of typeof keys === 'string' ? [keys] : keys)
					this.objects.delete(key);
			},
			list: async (options) => ({
				objects: [...this.objects.entries()]
					.filter(([key]) => key.startsWith(options?.prefix ?? ''))
					.map(([key, stored]) => objectFor(key, stored)),
				delimitedPrefixes: [],
				truncated: false,
			}),
		};
	}

	seed(
		key: string,
		value: string,
		httpMetadata: R2HTTPMetadata = { contentType: 'image/jpeg' },
	): void {
		this.objects.set(key, {
			bytes: new TextEncoder().encode(value),
			httpMetadata,
		});
	}
}

type HonoFixtureOptions = {
	authenticated?: boolean;
	handleAuth?: AppDependencies['handleAuth'];
	userId?: string;
	voiceProcessor?: VoiceProcessor;
};

export const createHonoFixture = (
	options: boolean | HonoFixtureOptions = true,
) => {
	const fixtureOptions =
		typeof options === 'boolean' ? { authenticated: options } : options;
	const d1 = new MockD1Controller();
	const r2 = new MockR2Controller();
	const email: SendEmail = {
		send: async () => {
			throw new Error('Unexpected email delivery in backend tests');
		},
	};
	const assets = Object.assign(async (..._args: unknown[]) => ({}), {
		fetch: async (input: RequestInfo | URL) => {
			const request = new Request(input);
			return new URL(request.url).pathname === '/'
				? new Response('<app-root></app-root>', {
						headers: { 'content-type': 'text/html' },
					})
				: new Response('Not found', { status: 404 });
		},
		connect: (): Socket => {
			throw new Error('Unexpected socket connection in backend tests');
		},
	}) satisfies Fetcher;
	const ai = {
		aiGatewayLogId: null,
		gateway: () => {
			throw new Error('Unexpected Workers AI gateway call in backend tests');
		},
		aiSearch: () => {
			throw new Error('Unexpected AI Search call in backend tests');
		},
		autorag: () => {
			throw new Error('Unexpected AutoRAG call in backend tests');
		},
		run: () => {
			throw new Error('Unexpected Workers AI call in backend tests');
		},
		models: async () => [],
		toMarkdown: () => {
			throw new Error('Unexpected Markdown conversion in backend tests');
		},
	} satisfies Ai;
	const env = {
		DB: d1.database,
		PHOTOS: r2.bucket,
		EMAIL: email,
		AI: ai,
		ASSETS: assets,
		APP_URL: 'http://localhost:8787',
		ENVIRONMENT: 'local',
	} satisfies Env;
	const auth: AppDependencies = {
		getSession: async () =>
			fixtureOptions.authenticated !== false
				? { user: { id: fixtureOptions.userId ?? 'owner-1' } }
				: null,
		handleAuth:
			fixtureOptions.handleAuth ??
			(async () => Response.json({ status: true })),
		voiceProcessor: () =>
			fixtureOptions.voiceProcessor ?? {
				process: async () => {
					throw new Error('Unexpected voice processing in backend tests');
				},
			},
	};
	const app = createApp(auth);
	return {
		d1,
		r2,
		env,
		request: (path: string, init?: RequestInit) => app.request(path, init, env),
	};
};
