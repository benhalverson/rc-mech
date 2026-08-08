import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { map, Observable, throwError } from 'rxjs';

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

export type SetupSnapshotPayload = {
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

@Service()
export class SoDialedImporterClient {
	private readonly http = inject(HttpClient);

	static isSupportedUrl(value: string): boolean {
		try {
			const url = new URL(value.trim());
			return (
				url.protocol === 'https:' &&
				(url.hostname === 'sodialed.com' ||
					url.hostname === 'www.sodialed.com') &&
				url.username === '' &&
				url.password === '' &&
				(url.port === '' || url.port === '443') &&
				/^\/setup\/[A-Za-z0-9]+\/?$/.test(url.pathname)
			);
		} catch {
			return false;
		}
	}

	preview(url: string, carId: string): Observable<SoDialedImportPreview> {
		if (!SoDialedImporterClient.isSupportedUrl(url)) {
			return throwError(() => new Error('Enter a supported So Dialed URL.'));
		}
		return this.http
			.post<{ draft: ImportDraft }>(
				'/api/v1/setup-imports/drafts',
				{ sourceUrl: url.trim(), carId },
				{ withCredentials: true },
			)
			.pipe(map(({ draft }) => importPreviewFromDraft(draft)));
	}

	update(draftId: string, payload: ImportDraftPatch): Observable<ImportDraft> {
		return this.http
			.patch<{ draft: ImportDraft }>(
				`/api/v1/setup-imports/drafts/${draftId}`,
				payload,
				{ withCredentials: true },
			)
			.pipe(map(({ draft }) => draft));
	}

	cancel(draftId: string): Observable<void> {
		return this.http.post<void>(
			`/api/v1/setup-imports/drafts/${draftId}/cancel`,
			{},
			{ withCredentials: true },
		);
	}

	accept(
		draftId: string,
		carId: string,
		name: string,
	): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			`/api/v1/setup-imports/drafts/${draftId}/accept`,
			{ carId, name, makeCurrent: false },
			{ withCredentials: true },
		);
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
type ImportDraftPatch = {
	carId?: string | null;
	knownValues?: Record<string, unknown>;
	uncertainValues?: Record<string, unknown>;
	rawValues?: Record<string, unknown>;
	unmappedValues?: Record<string, unknown>;
	sourceMetadata?: Record<string, unknown>;
};
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

type SetupResponse = { setup: SetupSnapshot };

@Service()
export class SetupSnapshotService {
	private readonly http = inject(HttpClient);

	create(
		carId: string,
		payload: SetupSnapshotPayload,
	): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			this.collectionEndpoint(carId),
			payload,
			{
				withCredentials: true,
			},
		);
	}

	update(
		carId: string,
		setupId: string,
		payload: SetupSnapshotPayload,
	): Observable<SetupResponse> {
		return this.http.patch<SetupResponse>(
			this.endpoint(carId, setupId),
			payload,
			{
				withCredentials: true,
			},
		);
	}

	copy(carId: string, setupId: string): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			`${this.endpoint(carId, setupId)}/copy`,
			{},
			{
				withCredentials: true,
			},
		);
	}

	selectCurrent(carId: string, setupId: string): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			`${this.endpoint(carId, setupId)}/current`,
			{},
			{
				withCredentials: true,
			},
		);
	}

	private collectionEndpoint(carId: string): string {
		return `/api/v1/cars/${encodeURIComponent(carId)}/setups`;
	}

	private endpoint(carId: string, setupId: string): string {
		return `${this.collectionEndpoint(carId)}/${encodeURIComponent(setupId)}`;
	}
}
