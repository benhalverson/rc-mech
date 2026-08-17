import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { inject, Service } from '@angular/core';
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
const layoutsResponse = object({ trackLayouts: array(layout) });
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
	readonly message: string;
};
const invalid = 'The Track-map response was invalid.';

type ParsedLayout = Omit<TrackLayout, 'mapVersions'> & {
	mapVersions?: TrackLayout['mapVersions'];
};
const normalizeLayout = (value: ParsedLayout): TrackLayout => ({
	...value,
	mapVersions: value.mapVersions ?? [],
});
export const parseTrackLayouts = (value: unknown): TrackLayout[] =>
	parse(layoutsResponse, value).trackLayouts.map(normalizeLayout);
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
				message: 'Track maps are unavailable. Check your connection.',
			};
		const parsed = apiError.safeParse(error.error);
		if (parsed.success)
			return {
				kind: 'rejected-response',
				status: error.status,
				message: parsed.data.error,
			};
		return {
			kind: 'http',
			status: error.status,
			message: 'The Track-map request was rejected.',
		};
	}
	return {
		kind: 'invalid-response',
		message:
			error instanceof Error && error.message.includes('Track-map')
				? error.message
				: invalid,
	};
};

@Service()
export class TrackMapGateway {
	private readonly http = inject(HttpClient);
	readonly layouts = httpResource<TrackLayout[]>(
		() => ({ url: '/api/v1/track-layouts', withCredentials: true }),
		{ parse: parseTrackLayouts },
	);
	getVersion(versionId: string): Observable<TrackMapVersion> {
		return this.http
			.get<unknown>(`/api/v1/track-map-versions/${versionId}`, {
				withCredentials: true,
			})
			.pipe(
				map(parseTrackMapVersion),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	createLayout(name: string): Observable<TrackLayout> {
		return this.http
			.post<unknown>(
				'/api/v1/track-layouts',
				{ name },
				{ withCredentials: true },
			)
			.pipe(
				map(parseTrackLayout),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	createDraft(
		layoutId: string,
		sourceVersionId?: string,
	): Observable<TrackMapVersion> {
		return this.http
			.post<unknown>(
				`/api/v1/track-layouts/${layoutId}/map-versions`,
				sourceVersionId ? { sourceVersionId } : {},
				{ withCredentials: true },
			)
			.pipe(
				map(parseTrackMapVersion),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	saveDraft(command: {
		versionId: string;
		corners: readonly TrackCorner[];
	}): Observable<TrackMapVersion> {
		return this.http
			.patch<unknown>(
				`/api/v1/track-map-versions/${command.versionId}`,
				{ corners: command.corners },
				{ withCredentials: true },
			)
			.pipe(
				map(parseTrackMapVersion),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	renameLayout(layoutId: string, name: string): Observable<TrackLayout> {
		return this.http
			.patch<unknown>(
				`/api/v1/track-layouts/${layoutId}`,
				{ name },
				{ withCredentials: true },
			)
			.pipe(
				map(parseTrackLayout),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	retireLayout(layoutId: string): Observable<TrackLayout> {
		return this.http
			.post<unknown>(
				`/api/v1/track-layouts/${layoutId}/retire`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map(parseTrackLayout),
				catchError((error: unknown) =>
					throwError(() => trackMapGatewayFailure(error)),
				),
			);
	}
	refresh(): void {
		this.layouts.reload();
	}
}
