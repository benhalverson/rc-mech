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
const version = object({
	id: string(),
	layoutId: string(),
	version: number(),
	status: union([literal('draft'), literal('approved'), literal('retired')]),
	sourceVersionId: nullable(string()),
	createdAt: string(),
	updatedAt: string(),
	approvedAt: nullable(string()),
	retiredAt: nullable(string()),
	corners: array(corner),
});
const mapVersionSummary = object({
	id: string(),
	version: number(),
	status: union([literal('draft'), literal('approved'), literal('retired')]),
	updatedAt: string(),
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
		corners: readonly TrackCorner[];
	}): Observable<TrackMapVersion> {
		return this.parseMutation(
			this.http.patch<unknown>(
				`/api/v1/track-map-versions/${command.versionId}`,
				{ corners: command.corners },
				{ withCredentials: true },
			),
			parseTrackMapVersion,
		);
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
