import { type z } from 'zod';
import {
	type CancelCommand,
	cancelCommandSchema,
	type ExecutionIdentity,
	executionIdentitySchema,
	type JobStatus,
	jobStatusSchema,
	rejectedJobResponseSchema,
	type TrackingJobSubmission,
	type TransferGrantCommand,
	trackingJobSubmissionSchema,
	transferGrantCommandSchema,
} from './contracts';

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_RESPONSE_BYTES = 64 * 1024;

type ProviderFetch = (
	input: RequestInfo | URL,
	init?: RequestInit,
) => Promise<Response>;

export type TrackingProviderFailureCode =
	| 'TRACKING_PROVIDER_UNAVAILABLE'
	| 'TRACKING_PROVIDER_RESPONSE_INVALID'
	| z.infer<typeof rejectedJobResponseSchema>['error']['code'];

export type TrackingProviderResult<T> =
	| { ok: true; value: T }
	| { ok: false; code: TrackingProviderFailureCode; retryable: boolean };

export interface TrackingProvider {
	submit(
		submission: TrackingJobSubmission,
	): Promise<TrackingProviderResult<JobStatus>>;
	status(
		identity: ExecutionIdentity,
	): Promise<TrackingProviderResult<JobStatus>>;
	cancel(command: CancelCommand): Promise<TrackingProviderResult<JobStatus>>;
	deliverTransferGrant(
		command: TransferGrantCommand,
	): Promise<TrackingProviderResult<JobStatus>>;
}

export type LocalSam31ProviderConfig = {
	origin: string;
	accessClientId: string;
	accessClientSecret: string;
	timeoutMs?: number;
	maxResponseBytes?: number;
	fetcher?: ProviderFetch;
};

export class LocalSam31Provider implements TrackingProvider {
	readonly #origin: URL;
	readonly #accessClientId: string;
	readonly #accessClientSecret: string;
	readonly #timeoutMs: number;
	readonly #maxResponseBytes: number;
	readonly #fetcher: ProviderFetch;

	constructor(config: LocalSam31ProviderConfig) {
		this.#origin = normalizeOrigin(config.origin);
		this.#accessClientId = requiredCredential(config.accessClientId);
		this.#accessClientSecret = requiredCredential(config.accessClientSecret);
		this.#timeoutMs = positiveBound(
			config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
			'Provider timeout',
		);
		this.#maxResponseBytes = positiveBound(
			config.maxResponseBytes ?? DEFAULT_RESPONSE_BYTES,
			'Provider response limit',
		);
		this.#fetcher = config.fetcher ?? fetch;
	}

	async submit(
		submission: TrackingJobSubmission,
	): Promise<TrackingProviderResult<JobStatus>> {
		const parsed = trackingJobSubmissionSchema.safeParse(submission);
		if (!parsed.success) return invalidRequest();
		return this.#request('/v1/jobs', 'POST', parsed.data, parsed.data);
	}

	async status(
		identity: ExecutionIdentity,
	): Promise<TrackingProviderResult<JobStatus>> {
		const parsed = executionIdentitySchema.safeParse(identity);
		if (!parsed.success) return invalidRequest();
		const query = new URLSearchParams({
			runId: parsed.data.runId,
			attemptId: parsed.data.attemptId,
			leaseId: parsed.data.leaseId,
			fencingToken: String(parsed.data.fencingToken),
			specificationDigest: parsed.data.specificationDigest,
			profileDigest: parsed.data.profileDigest,
		});
		return this.#request(
			`/v1/jobs/${encodeURIComponent(parsed.data.segmentId)}?${query}`,
			'GET',
			undefined,
			parsed.data,
		);
	}

	async cancel(
		command: CancelCommand,
	): Promise<TrackingProviderResult<JobStatus>> {
		const parsed = cancelCommandSchema.safeParse(command);
		if (!parsed.success) return invalidRequest();
		return this.#request(
			`/v1/jobs/${encodeURIComponent(parsed.data.segmentId)}/cancel`,
			'POST',
			parsed.data,
			parsed.data,
		);
	}

	async deliverTransferGrant(
		command: TransferGrantCommand,
	): Promise<TrackingProviderResult<JobStatus>> {
		const parsed = transferGrantCommandSchema.safeParse(command);
		if (!parsed.success) return invalidRequest();
		return this.#request(
			`/v1/jobs/${encodeURIComponent(parsed.data.segmentId)}/transfer-grants`,
			'POST',
			parsed.data,
			parsed.data,
		);
	}

	async #request(
		path: string,
		method: 'GET' | 'POST',
		body: object | undefined,
		expectedIdentity: ExecutionIdentity,
	): Promise<TrackingProviderResult<JobStatus>> {
		const url = resolveProviderUrl(this.#origin, path);
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), this.#timeoutMs);
		try {
			let response: Response;
			try {
				response = await this.#fetcher(
					new Request(url, {
						method,
						headers: {
							Accept: 'application/json',
							'CF-Access-Client-Id': this.#accessClientId,
							'CF-Access-Client-Secret': this.#accessClientSecret,
							...(body === undefined
								? {}
								: { 'Content-Type': 'application/json' }),
						},
						body: body === undefined ? undefined : JSON.stringify(body),
						redirect: 'manual',
						signal: controller.signal,
					}),
				);
			} catch {
				return unavailable();
			}
			const result = await parseProviderResponse(
				response,
				this.#maxResponseBytes,
				expectedIdentity,
			);
			return controller.signal.aborted ? unavailable() : result;
		} finally {
			clearTimeout(timeout);
		}
	}
}

const parseProviderResponse = async (
	response: Response,
	maxResponseBytes: number,
	expectedIdentity: ExecutionIdentity,
): Promise<TrackingProviderResult<JobStatus>> => {
	if (response.status >= 300 && response.status < 400) {
		return invalidResponse();
	}
	let value: unknown;
	try {
		value = JSON.parse(
			new TextDecoder().decode(
				await readBoundedBody(response, maxResponseBytes),
			),
		);
	} catch {
		return invalidResponse();
	}
	if (!response.ok) {
		const rejected = rejectedJobResponseSchema.safeParse(value);
		return rejected.success
			? {
					ok: false,
					code: rejected.data.error.code,
					retryable: isRetryableProviderCode(rejected.data.error.code),
				}
			: invalidResponse();
	}
	const parsed = jobStatusSchema.safeParse(value);
	if (!parsed.success || !isCurrentStatus(parsed.data, expectedIdentity)) {
		return invalidResponse();
	}
	return { ok: true, value: parsed.data };
};

const normalizeOrigin = (value: string): URL => {
	let origin: URL;
	try {
		origin = new URL(value);
	} catch {
		throw new Error('GPU provider origin is invalid');
	}
	if (
		origin.protocol !== 'https:' ||
		origin.hostname.length === 0 ||
		origin.port !== '' ||
		origin.username !== '' ||
		origin.password !== '' ||
		origin.pathname !== '/' ||
		origin.search !== '' ||
		origin.hash !== ''
	) {
		throw new Error('GPU provider origin must be a fixed HTTPS origin');
	}
	return new URL(origin.origin);
};

export const resolveProviderUrl = (origin: URL, path: string): URL => {
	if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
		throw new Error('GPU provider path must be relative to its fixed origin');
	}
	return new URL(path, origin);
};

const requiredCredential = (value: string): string => {
	if (value.length === 0 || value.length > 4096) {
		throw new Error('GPU provider Access credential is invalid');
	}
	return value;
};

const positiveBound = (value: number, label: string): number => {
	if (!Number.isSafeInteger(value) || value <= 0) {
		throw new Error(`${label} must be a positive integer`);
	}
	return value;
};

const readBoundedBody = async (
	response: Response,
	maxBytes: number,
): Promise<Uint8Array> => {
	const declared = response.headers.get('content-length');
	if (declared !== null) {
		const byteCount = Number(declared);
		if (
			!Number.isSafeInteger(byteCount) ||
			byteCount < 0 ||
			byteCount > maxBytes
		) {
			throw new Error('GPU provider response exceeded its bound');
		}
	}
	if (response.body === null) return new Uint8Array();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let byteCount = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			byteCount += value.byteLength;
			if (byteCount > maxBytes) {
				throw new Error('GPU provider response exceeded its bound');
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const combined = new Uint8Array(byteCount);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return combined;
};

const isCurrentStatus = (
	status: JobStatus,
	expected: ExecutionIdentity,
): boolean => {
	if (
		!identityMatches(status, expected) ||
		status.resolvedProfileDigest !== expected.profileDigest
	) {
		return false;
	}
	if (status.artifact === null) return true;
	return (
		identityMatches(status.artifact, expected) &&
		status.artifact.segment.observationSegmentId === expected.segmentId
	);
};

const identityMatches = (
	actual: ExecutionIdentity,
	expected: ExecutionIdentity,
): boolean =>
	actual.runId === expected.runId &&
	actual.segmentId === expected.segmentId &&
	actual.attemptId === expected.attemptId &&
	actual.leaseId === expected.leaseId &&
	actual.fencingToken === expected.fencingToken &&
	actual.specificationDigest === expected.specificationDigest &&
	actual.profileDigest === expected.profileDigest;

const isRetryableProviderCode = (
	code: z.infer<typeof rejectedJobResponseSchema>['error']['code'],
): boolean =>
	[
		'GPU_CAPACITY_BUSY',
		'PROFILE_UNAVAILABLE',
		'TRANSFER_FAILED',
		'TRACKING_FAILED',
		'JOB_INTERRUPTED',
	].includes(code);

const unavailable = (): TrackingProviderResult<never> => ({
	ok: false,
	code: 'TRACKING_PROVIDER_UNAVAILABLE',
	retryable: true,
});

const invalidRequest = (): TrackingProviderResult<never> => ({
	ok: false,
	code: 'TRACKING_PROVIDER_RESPONSE_INVALID',
	retryable: false,
});

const invalidResponse = invalidRequest;
