import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, Subject, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	TrackLayout,
	TrackMapRecording,
	TrackMapReferenceFrame,
	TrackMapVersion,
} from './track-map.models';
import { TrackMapGateway } from './track-map-gateway';
import { TrackMapStore, trackMapFailureMessage } from './track-map-store';

const corner = {
	key: 'turn-1',
	name: 'Turn 1',
	order: 1,
	entryGate: {
		start: { x: 0.1, y: 0.2 },
		end: { x: 0.2, y: 0.2 },
		direction: 'forward' as const,
	},
	exitGate: {
		start: { x: 0.3, y: 0.4 },
		end: { x: 0.4, y: 0.4 },
		direction: 'forward' as const,
	},
	cornerView: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
};
const version: TrackMapVersion = {
	id: 'version-1',
	layoutId: 'layout-1',
	version: 1,
	stateVersion: 1,
	status: 'draft',
	sourceVersionId: null,
	createdBy: 'owner-1',
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	approvedBy: null,
	approvedAt: null,
	retiredAt: null,
	referenceFrame: {
		raceVideoId: '33333333-3333-4333-8333-333333333333',
		timestampMs: 100,
		byteCount: 100,
		checksumSha256: 'a'.repeat(64),
		contentType: 'image/jpeg',
		contentUrl: '/api/v1/track-map-versions/map-1/reference-frame/content',
	},
	corners: [corner],
};
const layout: TrackLayout = {
	id: 'layout-1',
	name: 'Main',
	status: 'active',
	createdBy: 'owner-1',
	createdAt: '2026-01-01',
	updatedAt: '2026-01-01',
	retiredAt: null,
	mapVersions: [
		{
			id: version.id,
			version: 1,
			stateVersion: 1,
			status: 'draft',
			createdAt: version.createdAt,
			updatedAt: version.updatedAt,
			approvedAt: null,
			retiredAt: null,
		},
	],
};
const recording: TrackMapRecording = {
	id: 'recording-1',
	fileName: 'Main.mov',
	byteCount: 1_000,
	durationMs: 5_000,
	width: 1_920,
	height: 1_080,
};
const referenceFrame = version.referenceFrame as TrackMapReferenceFrame;

class FakeGateway {
	readonly canManage = signal(true);
	readonly layoutItems = signal<TrackLayout[]>([layout]);
	readonly layoutsHaveValue = signal(true);
	readonly layoutsLoading = signal(false);
	readonly layoutError = signal<unknown>(undefined);
	readonly versionHasValue = signal(true);
	readonly versionLoading = signal(false);
	readonly versionError = signal<unknown>(undefined);
	readonly loadedVersion = signal<TrackMapVersion>(version);
	readonly recordingItems = signal<TrackMapRecording[]>([recording]);
	readonly recordingsHaveValue = signal(true);
	readonly recordingsLoading = signal(false);
	readonly recordingsError = signal<unknown>(undefined);
	readonly layouts = {
		hasValue: () => this.layoutsHaveValue(),
		value: () => ({
			canManage: this.canManage(),
			trackLayouts: this.layoutItems(),
		}),
		isLoading: () => this.layoutsLoading(),
		error: (): unknown => this.layoutError(),
		reload: vi.fn(),
	};
	readonly version = {
		hasValue: () => this.versionHasValue(),
		value: () => this.loadedVersion(),
		isLoading: () => this.versionLoading(),
		error: (): unknown => this.versionError(),
		reload: vi.fn(),
	};
	readonly recordings = {
		hasValue: () => this.recordingsHaveValue(),
		value: () => this.recordingItems(),
		isLoading: () => this.recordingsLoading(),
		error: (): unknown => this.recordingsError(),
	};
	readonly loadRecordings = vi.fn();
	readonly selectVersion = vi.fn();
	readonly createLayout = vi.fn(() => of(layout));
	readonly createDraft = vi.fn(() => of(version));
	readonly saveDraft = vi.fn(() => of(version));
	readonly selectReferenceFrame = vi.fn(() => of(referenceFrame));
	readonly approveVersion = vi.fn(() =>
		of({ ...version, status: 'approved' as const, stateVersion: 2 }),
	);
	readonly retireVersion = vi.fn(() =>
		of({ ...version, status: 'retired' as const, stateVersion: 3 }),
	);
	readonly renameLayout = vi.fn(() => of(layout));
	readonly retireLayout = vi.fn(() => of(layout));
	readonly refresh = vi.fn();
	readonly refreshVersion = vi.fn();
}

describe('TrackMapStore', () => {
	let gateway: FakeGateway;
	let store: InstanceType<typeof TrackMapStore>;
	beforeEach(() => {
		gateway = new FakeGateway();
		TestBed.configureTestingModule({
			providers: [
				TrackMapStore,
				{ provide: TrackMapGateway, useValue: gateway },
			],
		});
		store = TestBed.inject(TrackMapStore);
	});
	afterEach(() => TestBed.resetTestingModule());

	it('projects managed reads and opens one current draft without stale data', () => {
		expect(store.layouts()).toEqual([layout]);
		expect(store.canManage()).toBe(true);
		expect(store.loading()).toBe(false);
		expect(store.error()).toBe('');
		expect(store.readError()).toBe('');
		store.openLayout(layout.id);
		expect(store.selectedLayoutId()).toBe(layout.id);
		expect(store.selectedVersionId()).toBe(version.id);
		expect(store.version()).toEqual(version);
		expect(gateway.selectVersion).toHaveBeenCalledWith(version.id);
		expect(gateway.loadRecordings).toHaveBeenCalledOnce();
		expect(store.recordings()).toEqual([recording]);
		store.openVersion('missing');
		expect(store.selectedVersionId()).toBe(version.id);
		store.openVersion(version.id);
		expect(gateway.selectVersion).toHaveBeenLastCalledWith(version.id);
		gateway.loadedVersion.set({ ...version, id: 'stale-version' });
		expect(store.version()).toBeNull();
		store.refresh();
		expect(gateway.refresh).toHaveBeenCalledOnce();
		expect(gateway.refreshVersion).toHaveBeenCalledOnce();
	});

	it('opens the approved version exposed to an ordinary user', () => {
		const approved = { ...version, status: 'approved' as const };
		gateway.canManage.set(false);
		gateway.loadedVersion.set(approved);
		gateway.layoutItems.set([
			{
				...layout,
				mapVersions: [
					{ ...layout.mapVersions[0], status: 'approved' as const },
				],
			},
		]);
		store.openLayout(layout.id);
		expect(store.selectedVersionId()).toBe(version.id);
		expect(store.version()).toEqual(approved);
		expect(gateway.loadRecordings).not.toHaveBeenCalled();
	});

	it('selects one immutable reference frame for a draft', () => {
		gateway.loadedVersion.set({ ...version, referenceFrame: null });
		store.openLayout(layout.id);
		store.selectReferenceFrame({
			raceVideoId: recording.id,
			timestampMs: 1_250,
		});
		expect(gateway.selectReferenceFrame).toHaveBeenCalledWith({
			versionId: version.id,
			raceVideoId: recording.id,
			timestampMs: 1_250,
		});
		expect(store.version()?.referenceFrame).toEqual(referenceFrame);
		expect(store.message()).toBe('Select frame saved.');
		store.selectReferenceFrame({ raceVideoId: recording.id, timestampMs: 0 });
		expect(gateway.selectReferenceFrame).toHaveBeenCalledOnce();
	});

	it('runs every mutation with immutable commands and refreshes summaries', () => {
		store.createLayout({ name: 'New' });
		store.createDraft({ layoutId: layout.id });
		expect(store.version()).toEqual(version);
		store.saveDraft({ corners: [] });
		expect(store.version()).toEqual(version);
		store.approveVersion();
		expect(store.version()?.status).toBe('approved');
		store.retireVersion();
		expect(store.version()?.status).toBe('retired');
		store.renameLayout({ name: 'Renamed' });
		store.retireLayout();
		expect(gateway.createLayout).toHaveBeenCalledWith('New');
		expect(gateway.createDraft).toHaveBeenCalledWith(layout.id, undefined);
		expect(gateway.saveDraft).toHaveBeenCalledWith({
			versionId: version.id,
			expectedStateVersion: 1,
			corners: [],
		});
		expect(gateway.approveVersion).toHaveBeenCalledWith(version.id, 1);
		expect(gateway.retireVersion).toHaveBeenCalledWith(version.id, 2);
		expect(gateway.renameLayout).toHaveBeenCalledWith(layout.id, 'Renamed');
		expect(gateway.retireLayout).toHaveBeenCalledWith(layout.id);
		expect(gateway.refresh).toHaveBeenCalled();
		expect(store.outcome().status).toBe('succeeded');
		expect(store.message()).toBe('Retire layout saved.');
	});

	it('guards unavailable commands and concurrent mutations', () => {
		gateway.canManage.set(false);
		store.createLayout({ name: 'Nope' });
		store.createDraft({ layoutId: layout.id });
		store.saveDraft({ corners: [] });
		store.selectReferenceFrame({ raceVideoId: recording.id, timestampMs: 0 });
		store.approveVersion();
		store.retireVersion();
		store.renameLayout({ name: 'Nope' });
		store.retireLayout();
		expect(gateway.createLayout).not.toHaveBeenCalled();

		gateway.canManage.set(true);
		const pending = new Subject<TrackLayout>();
		gateway.createLayout.mockReturnValueOnce(pending);
		store.createLayout({ name: 'Pending' });
		store.createLayout({ name: 'Ignored' });
		store.openLayout(layout.id);
		store.openVersion(version.id);
		expect(store.selectedLayoutId()).toBeNull();
		store.createDraft({ layoutId: layout.id });
		store.saveDraft({ corners: [] });
		store.selectReferenceFrame({ raceVideoId: recording.id, timestampMs: 0 });
		store.renameLayout({ name: 'Ignored' });
		store.retireLayout();
		expect(gateway.createLayout).toHaveBeenCalledTimes(1);
		expect(gateway.approveVersion).not.toHaveBeenCalled();
		expect(gateway.retireVersion).not.toHaveBeenCalled();
		pending.next(layout);
		pending.complete();
		expect(store.outcome().status).toBe('succeeded');
	});

	it('keeps retired layouts read-only', () => {
		gateway.layoutItems.set([{ ...layout, status: 'retired' }]);
		store.openLayout(layout.id);
		expect(store.selectedLayoutId()).toBe(layout.id);
		expect(store.selectedVersionId()).toBe(version.id);
		store.createDraft({ layoutId: layout.id });
		store.saveDraft({ corners: [] });
		store.selectReferenceFrame({ raceVideoId: recording.id, timestampMs: 0 });
		store.approveVersion();
		store.retireVersion();
		store.renameLayout({ name: 'Nope' });
		store.retireLayout();
		expect(gateway.createDraft).not.toHaveBeenCalled();
		expect(gateway.saveDraft).not.toHaveBeenCalled();
		expect(gateway.selectReferenceFrame).not.toHaveBeenCalled();
		expect(gateway.renameLayout).not.toHaveBeenCalled();
		expect(gateway.retireLayout).not.toHaveBeenCalled();
		expect(gateway.approveVersion).not.toHaveBeenCalled();
		expect(gateway.retireVersion).not.toHaveBeenCalled();
	});

	it('maps read and mutation failures into presentation state', () => {
		gateway.layoutsHaveValue.set(false);
		gateway.layoutsLoading.set(true);
		gateway.recordingsHaveValue.set(false);
		gateway.recordingsLoading.set(true);
		expect(store.layouts()).toEqual([]);
		expect(store.recordings()).toEqual([]);
		expect(store.canManage()).toBe(false);
		expect(store.loading()).toBe(true);
		gateway.layoutError.set(new Error('offline'));
		expect(store.readError()).toBe('Track maps could not be loaded.');

		gateway.layoutsHaveValue.set(true);
		gateway.layoutError.set(undefined);
		gateway.recordingsError.set(new Error('recordings offline'));
		expect(store.readError()).toBe(
			'Validated Race recordings could not be loaded.',
		);
		gateway.recordingsError.set(undefined);
		store.openLayout(layout.id);
		gateway.versionHasValue.set(false);
		gateway.versionError.set(new Error('bad version'));
		expect(store.version()).toBeNull();
		expect(store.readError()).toBe(
			'The selected Track map could not be loaded.',
		);

		gateway.createLayout.mockReturnValueOnce(
			throwError(() => ({ kind: 'rejected-response', detail: 'Conflict' })),
		);
		store.createLayout({ name: 'Conflict' });
		expect(store.error()).toBe('Conflict');
		expect(store.message()).toBe('');
	});

	it('covers every transport failure message and empty selections', () => {
		expect(trackMapFailureMessage({ kind: 'unavailable' })).toContain(
			'unavailable',
		);
		expect(trackMapFailureMessage({ kind: 'invalid-response' })).toContain(
			'invalid',
		);
		expect(trackMapFailureMessage({ kind: 'rejected-response' })).toContain(
			'rejected',
		);
		expect(trackMapFailureMessage({ kind: 'http', status: 500 })).toContain(
			'rejected',
		);
		store.openLayout('missing');
		expect(store.selectedVersionId()).toBeNull();
		expect(store.version()).toBeNull();
		store.saveDraft({ corners: [] });
		store.selectReferenceFrame({ raceVideoId: recording.id, timestampMs: 0 });
		store.approveVersion();
		store.retireVersion();
		store.renameLayout({ name: 'No layout' });
		store.retireLayout();
	});
});
