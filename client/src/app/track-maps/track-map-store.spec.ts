import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackLayout, TrackMapVersion } from './track-map.models';
import { TrackMapGateway } from './track-map-gateway';
import { TrackMapStore } from './track-map-store';

const version: TrackMapVersion = {
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
			status: 'draft',
			updatedAt: version.updatedAt,
		},
	],
};

class FakeGateway {
	layoutError: unknown;
	readonly layouts = {
		hasValue: () => true,
		value: () => [layout],
		isLoading: () => false,
		error: (): unknown => this.layoutError,
		reload: vi.fn(),
	};
	readonly getVersion = vi.fn(() => of(version));
	readonly createLayout = vi.fn(() => of(layout));
	readonly createDraft = vi.fn(() => of(version));
	readonly saveDraft = vi.fn(() => of(version));
	readonly renameLayout = vi.fn(() => of(layout));
	readonly retireLayout = vi.fn(() => of(layout));
	readonly refresh = vi.fn();
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
	it('projects layout reads and selection', () => {
		expect(store.layouts()).toEqual([layout]);
		expect(store.loading()).toBe(false);
		store.selectLayout(layout.id);
		expect(store.selectedLayoutId()).toBe(layout.id);
		store.loadVersion(version.id);
		expect(store.version()).toEqual(version);
		expect(store.selectedVersionId()).toBe(version.id);
		store.refresh();
		expect(gateway.refresh).toHaveBeenCalledOnce();
	});
	it('runs every mutation and publishes success', () => {
		store.createLayout('New');
		store.createDraft(layout.id);
		store.saveDraft([]);
		store.renameLayout('Renamed');
		store.retireLayout();
		expect(gateway.createLayout).toHaveBeenCalledWith('New');
		expect(gateway.createDraft).toHaveBeenCalledWith(layout.id, undefined);
		expect(store.outcome().status).toBe('succeeded');
	});
	it('keeps invalid selections safe and maps failures', () => {
		store.saveDraft([]);
		store.renameLayout('No layout');
		store.retireLayout();
		gateway.getVersion.mockReturnValueOnce(
			throwError(() => ({ message: 'No access' })),
		);
		store.loadVersion('missing');
		expect(store.error()).toBe('No access');
		gateway.createLayout.mockReturnValueOnce(
			throwError(() => ({ message: 'Conflict' })),
		);
		store.createLayout('Conflict');
		expect(store.error()).toBe('Conflict');
	});
	it('handles unavailable reads and failed mutations without throwing', () => {
		gateway.layouts.hasValue = () => false;
		gateway.layouts.isLoading = () => true;
		expect(store.layouts()).toEqual([]);
		expect(store.loading()).toBe(true);
		expect(store.readError()).toBe('');
		gateway.layoutError = new Error('offline');
		gateway.createLayout.mockReturnValueOnce(
			throwError(() => ({ message: 'Create failed' })),
		);
		store.createLayout('Broken');
		expect(store.readError()).toBe('Track maps could not be loaded.');
		gateway.createDraft.mockReturnValueOnce(
			throwError(() => ({ message: 'Draft failed' })),
		);
		gateway.saveDraft.mockReturnValueOnce(
			throwError(() => ({ message: 'Save failed' })),
		);
		gateway.renameLayout.mockReturnValueOnce(
			throwError(() => ({ message: 'Rename failed' })),
		);
		gateway.retireLayout.mockReturnValueOnce(
			throwError(() => ({ message: 'Retire failed' })),
		);
		store.selectLayout(layout.id);
		store.createDraft(layout.id);
		store.loadVersion('missing');
		store.createDraft(layout.id);
		store.saveDraft([]);
		store.renameLayout('Renamed');
		store.retireLayout();
		expect(store.error()).toBe('Retire failed');
	});
});
