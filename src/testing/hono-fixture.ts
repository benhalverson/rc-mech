import { expect } from 'vitest';
import { RaceRecordingAuthority } from '../driving-analysis/race-recording/race-recording-authority';
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

const d1Result = <T>(results: T[], changes = 0): D1Result<T> => ({
	success: true,
	meta: { ...D1_META, changes },
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
	| { kind: 'run'; rows?: readonly Record<string, unknown>[]; changes?: number }
	| {
			kind: 'batch';
			rows?: readonly (readonly Record<string, unknown>[])[];
			changes?: readonly number[];
	  }
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
	private steps: D1Step[] = [];
	private readonly queryByStatement = new WeakMap<
		D1PreparedStatement,
		string
	>();

	constructor() {
		this.database = this.createDatabase();
	}

	queue(...steps: D1Step[]): void {
		this.steps.push(...steps);
	}

	expectConsumed(): void {
		expect(this.steps).toEqual([]);
	}

	private take(kind: RecordedD1Query['operation']): D1Step {
		const step = this.steps.shift();
		if (!step) throw new Error(`Unexpected D1 ${kind} call`);
		if (step.kind === 'error') throw step.error;
		if (step.kind !== kind)
			throw new Error(`Expected D1 ${step.kind} call, received ${kind}`);
		return step;
	}

	private statement(query: string): D1PreparedStatement {
		let values: unknown[] = [];
		const record = (operation: RecordedD1Query['operation']) => {
			this.queries.push({ query, values, operation });
			return this.take(operation);
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
				return d1Result(
					[...((step.kind === 'run' ? step.rows : undefined) ?? [])],
					step.kind === 'run' ? (step.changes ?? 1) : 1,
				) as D1Result<T>;
			},
			all: async <T = Record<string, unknown>>() => {
				const step = record('all');
				return d1Result(
					step.kind === 'all' ? [...step.rows] : [],
				) as D1Result<T>;
			},
			raw: (async () => {
				const step = this.steps.shift();
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
		this.queryByStatement.set(statement, query);
		return statement;
	}

	private createDatabase(): D1Database {
		const prepare = (query: string) => this.statement(query);
		const batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
			this.batches.push(
				statements.map(
					(statement) => this.queryByStatement.get(statement) ?? '<unknown>',
				),
			);
			this.queries.push({ query: '<batch>', values: [], operation: 'batch' });
			const step = this.take('batch');
			const rows = step.kind === 'batch' ? step.rows : undefined;
			return statements.map((_, index) =>
				d1Result(
					(rows?.[index] ?? []) as T[],
					step.kind === 'batch' ? (step.changes?.[index] ?? 1) : 1,
				),
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
	etag: string;
	version: string;
	uploaded: Date;
};

type StoredMultipartUpload = {
	key: string;
	options?: R2MultipartOptions;
	parts: Map<number, { bytes: Uint8Array; etag: string }>;
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
	readonly multipartUploads = new Map<string, StoredMultipartUpload>();
	readonly bucket: R2Bucket;
	listTruncated = false;
	listCursor: string | undefined;
	private nextMultipartId = 0;
	private nextObjectVersion = 0;

	constructor() {
		const metadataFor = (key: string, stored: StoredR2Object): R2Object => ({
			key,
			version: stored.version,
			size: stored.bytes.byteLength,
			etag: stored.etag,
			httpEtag: `"${stored.etag}"`,
			checksums,
			uploaded: stored.uploaded,
			httpMetadata: stored.httpMetadata,
			customMetadata: stored.customMetadata,
			storageClass: 'Standard',
			writeHttpMetadata(headers) {
				if (stored.httpMetadata?.contentType)
					headers.set('content-type', stored.httpMetadata.contentType);
				if (stored.httpMetadata?.contentEncoding)
					headers.set('content-encoding', stored.httpMetadata.contentEncoding);
			},
		});

		const objectFor = (key: string, stored: StoredR2Object): R2ObjectBody => {
			let bodyUsed = false;
			const copy = () => stored.bytes.slice();
			const metadata = metadataFor(key, stored);
			return {
				...metadata,
				writeHttpMetadata: (headers) => metadata.writeHttpMetadata(headers),
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
		): Promise<R2Object | null> {
			const current = this.objects.get(key);
			if (!conditionMatches(current, options?.onlyIf)) return null;
			const httpMetadata =
				options?.httpMetadata instanceof Headers
					? {
							contentType:
								options.httpMetadata.get('content-type') ?? undefined,
						}
					: options?.httpMetadata;
			const ordinal = ++this.nextObjectVersion;
			const stored: StoredR2Object = {
				bytes: await bytesFor(value),
				httpMetadata,
				customMetadata: options?.customMetadata,
				etag: `test-etag-${ordinal}`,
				version: `test-version-${ordinal}`,
				uploaded: new Date('2026-01-01T00:00:00.000Z'),
			};
			this.objects.set(key, stored);
			return objectFor(key, stored);
		}

		function get(
			this: MockR2Controller,
			key: string,
			options: R2GetOptions & { onlyIf: R2Conditional | Headers },
		): Promise<R2ObjectBody | R2Object | null>;
		function get(
			this: MockR2Controller,
			key: string,
			options?: R2GetOptions,
		): Promise<R2ObjectBody | null>;
		async function get(
			this: MockR2Controller,
			key: string,
			options?: R2GetOptions,
		): Promise<R2ObjectBody | R2Object | null> {
			const stored = this.objects.get(key);
			if (!stored) return null;
			return conditionMatches(stored, options?.onlyIf)
				? objectFor(key, stored)
				: metadataFor(key, stored);
		}

		const multipart = (key: string, uploadId: string): R2MultipartUpload => {
			const state = () => {
				const upload = this.multipartUploads.get(uploadId);
				if (!upload || upload.key !== key)
					throw new Error('Multipart upload was not found');
				return upload;
			};
			return {
				key,
				uploadId,
				uploadPart: async (partNumber, value) => {
					const bytes = await bytesFor(value);
					const etag = `test-etag-${partNumber}-${bytes.byteLength}`;
					state().parts.set(partNumber, { bytes, etag });
					return { partNumber, etag };
				},
				abort: async () => {
					state();
					this.multipartUploads.delete(uploadId);
				},
				complete: async (uploadedParts) => {
					const upload = state();
					const chunks = uploadedParts.map(({ partNumber, etag }) => {
						const part = upload.parts.get(partNumber);
						if (!part || part.etag !== etag)
							throw new Error('Multipart part did not match');
						return part.bytes;
					});
					const size = chunks.reduce(
						(total, chunk) => total + chunk.byteLength,
						0,
					);
					const bytes = new Uint8Array(size);
					let offset = 0;
					for (const chunk of chunks) {
						bytes.set(chunk, offset);
						offset += chunk.byteLength;
					}
					const httpMetadata =
						upload.options?.httpMetadata instanceof Headers
							? {
									contentType:
										upload.options.httpMetadata.get('content-type') ??
										undefined,
								}
							: upload.options?.httpMetadata;
					const ordinal = ++this.nextObjectVersion;
					const stored: StoredR2Object = {
						bytes,
						httpMetadata,
						customMetadata: upload.options?.customMetadata,
						etag: `test-etag-${ordinal}`,
						version: `test-version-${ordinal}`,
						uploaded: new Date('2026-01-01T00:00:00.000Z'),
					};
					this.objects.set(key, stored);
					this.multipartUploads.delete(uploadId);
					return objectFor(key, stored);
				},
			};
		};

		this.bucket = {
			head: async (key) => {
				const stored = this.objects.get(key);
				return stored ? objectFor(key, stored) : null;
			},
			get: get.bind(this),
			put: put.bind(this),
			createMultipartUpload: async (key, options) => {
				const uploadId = `test-upload-${++this.nextMultipartId}`;
				this.multipartUploads.set(uploadId, {
					key,
					options,
					parts: new Map(),
				});
				return multipart(key, uploadId);
			},
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
				truncated: this.listTruncated,
				cursor: this.listCursor,
			}),
		};
	}

	seed(
		key: string,
		value: string | Uint8Array,
		httpMetadata: R2HTTPMetadata = { contentType: 'image/jpeg' },
		customMetadata?: Record<string, string>,
		uploaded = new Date('2026-01-01T00:00:00.000Z'),
	): void {
		const ordinal = ++this.nextObjectVersion;
		this.objects.set(key, {
			bytes:
				typeof value === 'string' ? new TextEncoder().encode(value) : value,
			httpMetadata,
			customMetadata,
			etag: `test-etag-${ordinal}`,
			version: `test-version-${ordinal}`,
			uploaded,
		});
	}
}

const conditionMatches = (
	stored: StoredR2Object | undefined,
	condition: R2Conditional | Headers | undefined,
): boolean => {
	if (!condition) return true;
	if (condition instanceof Headers) {
		const match = condition.get('if-match');
		if (match && (!stored || (match !== '*' && unquote(match) !== stored.etag)))
			return false;
		const noneMatch = condition.get('if-none-match');
		if (
			noneMatch &&
			stored &&
			(noneMatch === '*' || unquote(noneMatch) === stored.etag)
		)
			return false;
		return true;
	}
	if (condition.etagMatches !== undefined)
		return stored?.etag === unquote(condition.etagMatches);
	if (condition.etagDoesNotMatch !== undefined)
		return (
			!stored ||
			(condition.etagDoesNotMatch !== '*' &&
				stored.etag !== unquote(condition.etagDoesNotMatch))
		);
	if (condition.uploadedBefore !== undefined)
		return !!stored && stored.uploaded < condition.uploadedBefore;
	if (condition.uploadedAfter !== undefined)
		return !!stored && stored.uploaded > condition.uploadedAfter;
	return true;
};

const unquote = (value: string): string => value.replace(/^"|"$/g, '');

type HonoFixtureOptions = {
	authenticated?: boolean;
	handleAuth?: AppDependencies['handleAuth'];
	userId?: string;
	voiceProcessor?: VoiceProcessor;
	database?: D1Database;
	raceRecordingAuthority?: AppDependencies['raceRecordingAuthority'];
};

export const createHonoFixture = (
	options: boolean | HonoFixtureOptions = true,
) => {
	const fixtureOptions =
		typeof options === 'boolean' ? { authenticated: options } : options;
	const d1 = new MockD1Controller();
	const r2 = new MockR2Controller();
	const analysisMedia = new MockR2Controller();
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
		DB: fixtureOptions.database ?? d1.database,
		PHOTOS: r2.bucket,
		ANALYSIS_MEDIA: analysisMedia.bucket,
		EMAIL: email,
		AI: ai,
		ASSETS: assets,
		APP_URL: 'http://localhost:8787',
		ENVIRONMENT: 'local',
		GPU_LEASE_COORDINATOR: {} as Env['GPU_LEASE_COORDINATOR'],
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
		raceRecordingAuthority:
			fixtureOptions.raceRecordingAuthority ??
			((environment) =>
				new RaceRecordingAuthority(environment.DB, environment.ANALYSIS_MEDIA)),
	};
	const app = createApp(auth);
	return {
		d1,
		r2,
		analysisMedia,
		env,
		request: (path: string, init?: RequestInit) => app.request(path, init, env),
	};
};
