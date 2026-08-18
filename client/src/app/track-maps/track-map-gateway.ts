import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Service, signal } from '@angular/core';
import { catchError, map, type Observable, throwError } from 'rxjs';
import {
	array,
	literal,
	nullable,
	number,
	object,
	optional,
	parse,
	string,
	union,
} from 'zod/mini';
import type {
	TrackCorner,
	TrackLayout,
	TrackLayoutCollection,
	TrackMapRecording,
	TrackMapReferenceFrame,
	TrackMapVersion,
} from './track-map.models';

const point = object({ x: number(), y: number() });
const gate = object({
	start: point,
	end: point,
	direction: union([literal('forward'), literal('reverse')]),
});
const corner = object({
	key: string(),
	name: string(),
	order: number(),
	entryGate: gate,
	exitGate: gate,
	cornerView: object({
		x: number(),
		y: number(),
		width: number(),
		height: number(),
	}),
});
const referenceFrame = object({
	raceVideoId: string(),
	timestampMs: number(),
	byteCount: number(),
	checksumSha256: string(),
	contentType: literal('image/jpeg'),
});
const version = object({
	id: string(),
	layoutId: string(),
	version: number(),
	stateVersion: number(),
	status: union([literal('draft'), literal('approved'), literal('retired')]),
	sourceVersionId: nullable(string()),
	createdBy: string(),
	createdAt: string(),
	updatedAt: string(),
	approvedBy: nullable(string()),
	approvedAt: nullable(string()),
	retiredAt: nullable(string()),
	corners: array(corner),
	referenceFrame: nullable(referenceFrame),
});
const mapVersionSummary = object({
	id: string(),
	version: number(),
	stateVersion: number(),
	status: union([literal('draft'), literal('approved'), literal('retired')]),
	createdAt: string(),
	updatedAt: string(),
	approvedAt: nullable(string()),
	retiredAt: nullable(string()),
});
const layout = object({
	id: string(),
	name: string(),
	status: union([literal('active'), literal('retired')]),
	createdBy: string(),
	createdAt: string(),
	updatedAt: string(),
	retiredAt: nullable(string()),
	mapVersions: optional(array(mapVersionSummary)),
});
const layoutsResponse = object({
	canManage: union([literal(true), literal(false)]),
	trackLayouts: array(layout),
});
const versionResponse = object({ trackMapVersion: version });
const referenceFrameResponse = object({ referenceFrame });
const recording = object({
	id: string(),
	fileName: string(),
	byteCount: number(),
	durationMs: number(),
	width: number(),
	height: number(),
});
const recordingsResponse = object({ raceVideos: array(recording) });
const layoutResponse = object({ trackLayout: layout });
const apiError = object({ error: string() });

export type TrackMapGatewayFailure = {
	readonly kind:
		| 'http'
		| 'unavailable'
		| 'invalid-response'
		| 'rejected-response';
	readonly status?: number;
	readonly detail?: string;
};

type ParsedLayout = Omit<TrackLayout, 'mapVersions'> & {
	mapVersions?: TrackLayout['mapVersions'];
};
const normalizeLayout = (value: ParsedLayout): TrackLayout => ({
	...value,
	mapVersions: value.mapVersions ?? [],
});
export const parseTrackLayouts = (value: unknown): TrackLayoutCollection => {
	const parsed = parse(layoutsResponse, value);
	return {
		canManage: parsed.canManage,
		trackLayouts: parsed.trackLayouts.map(normalizeLayout),
	};
};
export const parseTrackMapVersion = (value: unknown): TrackMapVersion =>
	parse(versionResponse, value).trackMapVersion;
export const parseTrackMapReferenceFrame = (
	value: unknown,
): TrackMapReferenceFrame =>
	parse(referenceFrameResponse, value).referenceFrame;
export const parseTrackMapRecordings = (value: unknown): TrackMapRecording[] =>
	parse(recordingsResponse, value).raceVideos;
export const parseTrackLayout = (value: unknown): TrackLayout =>
	normalizeLayout(parse(layoutResponse, value).trackLayout);
export const trackMapGatewayFailure = (
	error: unknown,
): TrackMapGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 0)
			return {
				kind: 'unavailable',
			};
		const parsed = apiError.safeParse(error.error);
		if (parsed.success)
			return {
				kind: 'rejected-response',
				status: error.status,
				detail: parsed.data.error,
			};
		return {
			kind: 'http',
			status: error.status,
		};
	}
	return { kind: 'invalid-response' };
};

@Service()
export class TrackMapGateway {
	private readonly http = inject(HttpClient);
	private readonly versionId = signal('');
	private readonly recordingsEnabled = signal(false);
	readonly layouts = httpResource<TrackLayoutCollection>(
		() => ({ url: '/api/v1/track-layouts', withCredentials: true }),
		{ parse: parseTrackLayouts },
	);
	readonly version = httpResource<TrackMapVersion>(
		() => {
			const versionId = this.versionId();
			return versionId
				? {
						url: `/api/v1/track-map-versions/${encodeURIComponent(versionId)}`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseTrackMapVersion },
	);
	readonly recordings = httpResource<TrackMapRecording[]>(
		() =>
			this.recordingsEnabled()
				? { url: '/api/v1/track-map-recordings', withCredentials: true }
				: undefined,
		{ parse: parseTrackMapRecordings },
	);
	loadRecordings(): void {
		this.recordingsEnabled.set(true);
	}
	selectVersion(versionId: string | null): void {
		this.versionId.set(versionId ?? '');
	}
	createLayout(name: string): Observable<TrackLayout> {
		return this.parseMutation(
			this.http.post<unknown>(
				'/api/v1/track-layouts',
				{ name },
				{ withCredentials: true },
			),
			parseTrackLayout,
		);
	}
	createDraft(
		layoutId: string,
		sourceVersionId?: string,
	): Observable<TrackMapVersion> {
		return this.parseMutation(
			this.http.post<unknown>(
				`/api/v1/track-layouts/${layoutId}/map-versions`,
				sourceVersionId ? { sourceVersionId } : {},
				{ withCredentials: true },
			),
			parseTrackMapVersion,
		);
	}
	saveDraft(command: {
		versionId: string;
		expectedStateVersion: number;
		corners: readonly TrackCorner[];
	}): Observable<TrackMapVersion> {
		return this.parseMutation(
			this.http.patch<unknown>(
				`/api/v1/track-map-versions/${command.versionId}`,
				{
					expectedStateVersion: command.expectedStateVersion,
					corners: command.corners,
				},
				{ withCredentials: true },
			),
			parseTrackMapVersion,
		);
	}
	selectReferenceFrame(command: {
		versionId: string;
		raceVideoId: string;
		timestampMs: number;
	}): Observable<TrackMapReferenceFrame> {
		return this.parseMutation(
			this.http.post<unknown>(
				`/api/v1/track-map-versions/${command.versionId}/reference-frame`,
				{
					raceVideoId: command.raceVideoId,
					timestampMs: command.timestampMs,
				},
				{ withCredentials: true },
			),
			parseTrackMapReferenceFrame,
		);
	}
	approveVersion(
		versionId: string,
		expectedStateVersion: number,
	): Observable<TrackMapVersion> {
		return this.decideVersion(versionId, 'approve', expectedStateVersion);
	}
	retireVersion(
		versionId: string,
		expectedStateVersion: number,
	): Observable<TrackMapVersion> {
		return this.decideVersion(versionId, 'retire', expectedStateVersion);
	}
	renameLayout(layoutId: string, name: string): Observable<TrackLayout> {
		return this.parseMutation(
			this.http.patch<unknown>(
				`/api/v1/track-layouts/${layoutId}`,
				{ name },
				{ withCredentials: true },
			),
			parseTrackLayout,
		);
	}
	retireLayout(layoutId: string): Observable<TrackLayout> {
		return this.parseMutation(
			this.http.post<unknown>(
				`/api/v1/track-layouts/${layoutId}/retire`,
				{},
				{ withCredentials: true },
			),
			parseTrackLayout,
		);
	}
	refresh(): void {
		this.layouts.reload();
	}
	refreshVersion(): void {
		this.version.reload();
	}
	private decideVersion(
		versionId: string,
		action: 'approve' | 'retire',
		expectedStateVersion: number,
	): Observable<TrackMapVersion> {
		return this.parseMutation(
			this.http.post<unknown>(
				`/api/v1/track-map-versions/${versionId}/${action}`,
				{ expectedStateVersion },
				{ withCredentials: true },
			),
			parseTrackMapVersion,
		);
	}
	private parseMutation<T>(
		request: Observable<unknown>,
		parser: (value: unknown) => T,
	): Observable<T> {
		return request.pipe(
			map(parser),
			catchError((error: unknown) =>
				throwError(() => trackMapGatewayFailure(error)),
			),
		);
	}
}
