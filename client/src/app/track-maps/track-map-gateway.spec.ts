import { HttpErrorResponse, provideHttpClient } from '@angular/common/http';
import {
	HttpTestingController,
	provideHttpClientTesting,
} from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import type { Observable } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	parseTrackLayout,
	parseTrackLayouts,
	parseTrackMapVersion,
	TrackMapGateway,
	trackMapGatewayFailure,
} from './track-map-gateway';

const version = {
	id: 'version-1',
	layoutId: 'layout-1',
	version: 1,
	status: 'draft',
	sourceVersionId: null,
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	approvedAt: null,
	retiredAt: null,
	corners: [],
} as const;
const layout = {
	id: 'layout-1',
	name: 'Main',
	status: 'active',
	createdBy: 'owner-1',
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	retiredAt: null,
	mapVersions: [],
} as const;

describe('TrackMapGateway', () => {
	let gateway: TrackMapGateway;
	let http: HttpTestingController;
	beforeEach(() => {
		TestBed.configureTestingModule({
			providers: [
				provideHttpClient(),
				provideHttpClientTesting(),
				TrackMapGateway,
			],
		});
		gateway = TestBed.inject(TrackMapGateway);
		http = TestBed.inject(HttpTestingController);
	});
	afterEach(() => {
		http.verify();
		TestBed.resetTestingModule();
	});
	it('parses canonical responses and normalizes summaries', () => {
		expect(
			parseTrackLayouts({
				trackLayouts: [{ ...layout, mapVersions: undefined }],
			}),
		).toEqual([{ ...layout, mapVersions: [] }]);
		expect(parseTrackLayout({ trackLayout: layout })).toEqual(layout);
		expect(parseTrackMapVersion({ trackMapVersion: version })).toEqual(version);
		expect(() => parseTrackLayouts({})).toThrow();
	});
	it('maps transport failures', () => {
		expect(
			trackMapGatewayFailure(new HttpErrorResponse({ status: 0 })).kind,
		).toBe('unavailable');
		expect(
			trackMapGatewayFailure(
				new HttpErrorResponse({ status: 409, error: { error: 'Conflict' } }),
			),
		).toMatchObject({
			kind: 'rejected-response',
			status: 409,
			message: 'Conflict',
		});
		expect(
			trackMapGatewayFailure(new HttpErrorResponse({ status: 500, error: {} })),
		).toMatchObject({ kind: 'http', status: 500 });
		expect(
			trackMapGatewayFailure(new Error('The Track-map response was invalid.'))
				.kind,
		).toBe('invalid-response');
		expect(trackMapGatewayFailure('offline').kind).toBe('invalid-response');
	});
	it('owns reads and mutations with credentials', async () => {
		gateway.layouts.value();
		let read: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			read = http.expectOne('/api/v1/track-layouts');
		});
		if (!read) throw new Error('Track-map list request was not issued.');
		read.flush({ trackLayouts: [] });
		gateway.getVersion('version-1').subscribe();
		http
			.expectOne(
				(request) => request.url === '/api/v1/track-map-versions/version-1',
			)
			.flush({ trackMapVersion: version });
		gateway.createLayout('Main').subscribe();
		http
			.expectOne(
				(request) =>
					request.method === 'POST' && request.url === '/api/v1/track-layouts',
			)
			.flush({ trackLayout: layout });
		gateway.createDraft('layout-1').subscribe();
		http
			.expectOne(
				(request) =>
					request.method === 'POST' && request.url.includes('/map-versions'),
			)
			.flush({ trackMapVersion: version });
		gateway.saveDraft({ versionId: 'version-1', corners: [] }).subscribe();
		http
			.expectOne(
				(request) =>
					request.method === 'PATCH' &&
					request.url.includes('/track-map-versions'),
			)
			.flush({ trackMapVersion: version });
		gateway.renameLayout('layout-1', 'Renamed').subscribe();
		http
			.expectOne(
				(request) =>
					request.method === 'PATCH' && request.url.includes('/track-layouts'),
			)
			.flush({ trackLayout: layout });
		gateway.retireLayout('layout-1').subscribe();
		http
			.expectOne(
				(request) =>
					request.method === 'POST' && request.url.includes('/retire'),
			)
			.flush({ trackLayout: layout });
		gateway.refresh();
	});
	it('maps rejected responses for every gateway operation', () => {
		const operations: Array<() => Observable<unknown>> = [
			() => gateway.getVersion('version-1'),
			() => gateway.createLayout('Main'),
			() => gateway.createDraft('layout-1', 'version-1'),
			() => gateway.saveDraft({ versionId: 'version-1', corners: [] }),
			() => gateway.renameLayout('layout-1', 'Renamed'),
			() => gateway.retireLayout('layout-1'),
		];
		for (const operation of operations) {
			let failure: unknown;
			operation().subscribe({ error: (error) => (failure = error) });
			http
				.expectOne((request) => request.url.startsWith('/api/v1/'))
				.flush({ error: 'Rejected' }, { status: 409, statusText: 'Conflict' });
			expect(failure).toMatchObject({ kind: 'rejected-response', status: 409 });
		}
	});
});
