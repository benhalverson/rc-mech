import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, map, Observable, throwError } from 'rxjs';
import { array, custom, literal, object, string } from 'zod/mini';
import { isSupportedSoDialedUrl } from './setup-import-rules';

export const setupSectionKeys = [
	'vehicle',
	'drivetrain',
	'electronics',
	'tires',
	'shocks',
	'frontSuspension',
	'rearSuspension',
	'notes',
] as const;

export type SetupSectionKey = (typeof setupSectionKeys)[number];
export type SetupSectionValues = Record<string, string | null>;
export type SetupSections = Record<SetupSectionKey, SetupSectionValues>;

export type SetupSource = {
	url?: string | null;
	pdfUrl?: string | null;
	pdfTitle?: string | null;
	pdfPage?: number | null;
};

export type SetupContext = {
	recordedAt?: string | null;
	track?: string | null;
	event?: string | null;
	surface?: string | null;
	traction?: string | null;
	moisture?: string | null;
	condition?: string | null;
	temperature?: string | null;
};

export type SetupSnapshot = {
	id: string;
	carId: string;
	name: string;
	current?: boolean;
	context?: SetupContext | null;
	sections: SetupSections;
	source?: SetupSource | null;
	copiedFromSetupId?: string | null;
	unmappedValues?: Record<string, unknown> | null;
	rawValues?: Record<string, unknown> | null;
	createdAt?: string;
	updatedAt?: string;
};

export type SetupSnapshotDraft = {
	name: string;
	status?: 'draft' | 'reviewed' | 'active';
	setupDate?: string | null;
	track?: string | null;
	event?: string | null;
	surface?: string | null;
	traction?: string | null;
	moisture?: string | null;
	condition?: string | null;
	temperature?: string | null;
	vehicle?: Record<string, unknown> | null;
	drivetrain?: Record<string, unknown> | null;
	electronics?: Record<string, unknown> | null;
	tires?: Record<string, unknown> | null;
	shocks?: Record<string, unknown> | null;
	frontSuspension?: Record<string, unknown> | null;
	rearSuspension?: Record<string, unknown> | null;
	notes?: string | null;
	sourceUrl?: string | null;
	sourcePdfReference?: string | null;
	sourceMetadata?: Record<string, unknown> | null;
	rawValues?: Record<string, unknown> | null;
	unmappedValues?: Record<string, unknown> | null;
	makeCurrent?: boolean;
};

export type ImportCarOption = {
	id: string;
	name: string;
	make?: string | null;
	model?: string | null;
	archivedAt?: string | null;
};

export type SoDialedImportPreview = {
	draftId: string;
	source: SetupSource & { title?: string | null };
	carIdentity: {
		make?: string | null;
		model?: string | null;
		name?: string | null;
	};
	context: SetupContext;
	sections: SetupSections;
	uncertainValues: Record<string, unknown>;
	unmappedValues: Record<string, unknown>;
	rawValues: Record<string, unknown>;
	duplicate?: {
		setupId: string;
		name: string;
		createdAt?: string;
	} | null;
};

export type SetupGatewayFailure =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'rejected'; readonly message: string }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'unavailable' };

class InvalidSetupResponse extends Error {}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === 'object' && value !== null && !Array.isArray(value);

const setupSnapshotSchema = custom<SetupSnapshot>(
	(value) =>
		isRecord(value) &&
		typeof value['id'] === 'string' &&
		typeof value['carId'] === 'string' &&
		typeof value['name'] === 'string' &&
		isRecord(value['sections']),
);
const setupCollectionSchema = object({ setups: array(setupSnapshotSchema) });
const setupMutationSchema = object({ setup: setupSnapshotSchema });
const acknowledgementSchema = object({ ok: literal(true) });

const parse = <T>(
	result: { success: true; data: T } | { success: false },
): T => {
	if (!result.success) throw new InvalidSetupResponse();
	return result.data;
};

export const parseSetupCollection = (value: unknown): SetupSnapshot[] =>
	parse(setupCollectionSchema.safeParse(value)).setups;

export const parseSetupMutation = (value: unknown): SetupSnapshot =>
	parse(setupMutationSchema.safeParse(value)).setup;

export const setupGatewayFailure = (error: unknown): SetupGatewayFailure => {
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof InvalidSetupResponse
		? { kind: 'invalid-response' }
		: error instanceof Error && error.message
			? { kind: 'rejected', message: error.message }
			: { kind: 'unavailable' };
};

const mapFailure = (error: unknown): Observable<never> =>
	throwError(() => setupGatewayFailure(error));

@Injectable()
export class SoDialedImportGateway {
	private readonly http = inject(HttpClient);

	preview(url: string, carId: string): Observable<SoDialedImportPreview> {
		if (!isSupportedSoDialedUrl(url)) {
			return throwError(() => new Error('Enter a supported So Dialed URL.'));
		}
		return this.http
			.post<{ draft: ImportDraft }>(
				'/api/v1/setup-imports/drafts',
				{ sourceUrl: url.trim(), carId },
				{ withCredentials: true },
			)
			.pipe(
				map((value) => parseImportPreview(value)),
				catchError(mapFailure),
			);
	}

	update(draftId: string, review: SetupImportReview): Observable<void> {
		return this.http
			.patch<{ draft: ImportDraft }>(
				`/api/v1/setup-imports/drafts/${draftId}`,
				review,
				{ withCredentials: true },
			)
			.pipe(
				map((value) => {
					parse(importDraftUpdateSchema.safeParse(value));
				}),
				catchError(mapFailure),
			);
	}

	cancel(draftId: string): Observable<void> {
		return this.http
			.post<unknown>(
				`/api/v1/setup-imports/drafts/${draftId}/cancel`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map((value) => {
					parse(acknowledgementSchema.safeParse(value));
				}),
				catchError(mapFailure),
			);
	}

	accept(
		draftId: string,
		carId: string,
		name: string,
	): Observable<SetupSnapshot> {
		return this.http
			.post<unknown>(
				`/api/v1/setup-imports/drafts/${draftId}/accept`,
				{ carId, name, makeCurrent: false },
				{ withCredentials: true },
			)
			.pipe(map(parseSetupMutation), catchError(mapFailure));
	}
}

type ImportDraft = {
	id: string;
	carId?: string | null;
	sourceUrl: string;
	sourceIdentity: Record<string, unknown>;
	source: {
		url: string;
		hasPdfReference?: boolean;
		metadata?: unknown;
	};
	knownValues: Record<string, unknown>;
	uncertainValues: Record<string, unknown>;
	rawValues: Record<string, unknown>;
	unmappedValues: Record<string, unknown>;
};
export type SetupImportReview = {
	carId?: string | null;
	knownValues?: Record<string, unknown>;
	uncertainValues?: Record<string, unknown>;
	rawValues?: Record<string, unknown>;
	unmappedValues?: Record<string, unknown>;
	sourceMetadata?: Record<string, unknown>;
};

const importDraftSchema = object({
	draft: custom<ImportDraft>(
		(value) =>
			isRecord(value) &&
			typeof value['id'] === 'string' &&
			typeof value['sourceUrl'] === 'string' &&
			isRecord(value['sourceIdentity']) &&
			isRecord(value['source']) &&
			isRecord(value['knownValues']) &&
			isRecord(value['uncertainValues']) &&
			isRecord(value['rawValues']) &&
			isRecord(value['unmappedValues']),
	),
});
const importDraftUpdateSchema = object({ draft: object({ id: string() }) });

export const parseImportPreview = (value: unknown): SoDialedImportPreview =>
	importPreviewFromDraft(parse(importDraftSchema.safeParse(value)).draft);

const importPreviewFromDraft = (draft: ImportDraft): SoDialedImportPreview => {
	const rawMetadata = draft.source.metadata;
	const metadata =
		rawMetadata !== null &&
		typeof rawMetadata === 'object' &&
		!Array.isArray(rawMetadata)
			? (rawMetadata as Record<string, unknown>)
			: {};
	const pdfPage = metadata['pdfPage'];
	return {
		draftId: draft.id,
		source: {
			...metadata,
			url: draft.source.url,
			pdfUrl: null,
			pdfTitle: draft.source.hasPdfReference ? 'Original setup PDF' : null,
			pdfPage: typeof pdfPage === 'number' ? pdfPage : null,
		},
		carIdentity: {
			name:
				typeof (draft.sourceIdentity as { name?: unknown }).name === 'string'
					? ((draft.sourceIdentity as { name?: unknown }).name as string)
					: null,
			make:
				typeof (draft.sourceIdentity as { make?: unknown }).make === 'string'
					? ((draft.sourceIdentity as { make?: unknown }).make as string)
					: null,
			model:
				typeof (draft.sourceIdentity as { model?: unknown }).model === 'string'
					? ((draft.sourceIdentity as { model?: unknown }).model as string)
					: null,
		},
		context: (draft.knownValues as { context?: SetupContext }).context ?? {},
		sections:
			(draft.knownValues as { sections?: SetupSections }).sections ??
			emptyImportSections(),
		uncertainValues: draft.uncertainValues,
		unmappedValues: draft.unmappedValues,
		rawValues: draft.rawValues,
	};
};
const emptyImportSections = (): SetupSections =>
	Object.fromEntries(setupSectionKeys.map((key) => [key, {}])) as SetupSections;

@Injectable()
export class SetupSnapshotGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly collection = httpResource<SetupSnapshot[]>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: this.collectionEndpoint(carId),
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseSetupCollection },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	create(carId: string, draft: SetupSnapshotDraft): Observable<SetupSnapshot> {
		return this.http
			.post<unknown>(this.collectionEndpoint(carId), draft, {
				withCredentials: true,
			})
			.pipe(map(parseSetupMutation), catchError(mapFailure));
	}

	update(
		carId: string,
		setupId: string,
		draft: SetupSnapshotDraft,
	): Observable<SetupSnapshot> {
		return this.http
			.patch<unknown>(this.endpoint(carId, setupId), draft, {
				withCredentials: true,
			})
			.pipe(map(parseSetupMutation), catchError(mapFailure));
	}

	copy(carId: string, setupId: string): Observable<SetupSnapshot> {
		return this.http
			.post<unknown>(
				`${this.endpoint(carId, setupId)}/copy`,
				{},
				{
					withCredentials: true,
				},
			)
			.pipe(map(parseSetupMutation), catchError(mapFailure));
	}

	selectCurrent(carId: string, setupId: string): Observable<SetupSnapshot> {
		return this.http
			.post<unknown>(
				`${this.endpoint(carId, setupId)}/current`,
				{},
				{
					withCredentials: true,
				},
			)
			.pipe(map(parseSetupMutation), catchError(mapFailure));
	}

	failure(): SetupGatewayFailure | null {
		const error = this.collection.error();
		return error ? setupGatewayFailure(error) : null;
	}

	refresh(): void {
		this.collection.reload();
	}

	private collectionEndpoint(carId: string): string {
		return `/api/v1/cars/${encodeURIComponent(carId)}/setups`;
	}

	private endpoint(carId: string, setupId: string): string {
		return `${this.collectionEndpoint(carId)}/${encodeURIComponent(setupId)}`;
	}
}
