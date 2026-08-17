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
				canManage: true,
				trackLayouts: [{ ...layout, mapVersions: undefined }],
			}),
		).toEqual({
			canManage: true,
			trackLayouts: [{ ...layout, mapVersions: [] }],
		});
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
			detail: 'Conflict',
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
		expect(read.request.withCredentials).toBe(true);
		read.flush({ canManage: true, trackLayouts: [] });
		gateway.selectVersion('version-1');
		gateway.version.value();
		let versionRead: ReturnType<HttpTestingController['expectOne']> | undefined;
		await vi.waitFor(() => {
			versionRead = http.expectOne(
				(request) => request.url === '/api/v1/track-map-versions/version-1',
			);
		});
		if (!versionRead)
			throw new Error('Track-map version request was not issued.');
		expect(versionRead.request.withCredentials).toBe(true);
		versionRead.flush({ trackMapVersion: version });
		gateway.createLayout('Main').subscribe();
		const createLayoutRequest = http.expectOne(
			(request) =>
				request.method === 'POST' && request.url === '/api/v1/track-layouts',
		);
		expect(createLayoutRequest.request.withCredentials).toBe(true);
		expect(createLayoutRequest.request.body).toEqual({ name: 'Main' });
		createLayoutRequest.flush({ trackLayout: layout });
		gateway.createDraft('layout-1').subscribe();
		const createDraftRequest = http.expectOne(
			(request) =>
				request.method === 'POST' && request.url.includes('/map-versions'),
		);
		expect(createDraftRequest.request.withCredentials).toBe(true);
		expect(createDraftRequest.request.body).toEqual({});
		createDraftRequest.flush({ trackMapVersion: version });
		gateway.saveDraft({ versionId: 'version-1', corners: [] }).subscribe();
		const saveDraftRequest = http.expectOne(
			(request) =>
				request.method === 'PATCH' &&
				request.url.includes('/track-map-versions'),
		);
		expect(saveDraftRequest.request.withCredentials).toBe(true);
		expect(saveDraftRequest.request.body).toEqual({ corners: [] });
		saveDraftRequest.flush({ trackMapVersion: version });
		gateway.renameLayout('layout-1', 'Renamed').subscribe();
		const renameLayoutRequest = http.expectOne(
			(request) =>
				request.method === 'PATCH' && request.url.includes('/track-layouts'),
		);
		expect(renameLayoutRequest.request.withCredentials).toBe(true);
		expect(renameLayoutRequest.request.body).toEqual({ name: 'Renamed' });
		renameLayoutRequest.flush({ trackLayout: layout });
		gateway.retireLayout('layout-1').subscribe();
		const retireLayoutRequest = http.expectOne(
			(request) => request.method === 'POST' && request.url.includes('/retire'),
		);
		expect(retireLayoutRequest.request.withCredentials).toBe(true);
		expect(retireLayoutRequest.request.body).toEqual({});
		retireLayoutRequest.flush({ trackLayout: layout });
		gateway.refresh();
		gateway.selectVersion(null);
		gateway.refreshVersion();
	});
	it('maps rejected responses for every gateway operation', () => {
		const operations: Array<() => Observable<unknown>> = [
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
