import { signal } from '@angular/core';
import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackLayout, TrackMapVersion } from './track-map.models';
import { TrackMapStore } from './track-map-store';
import { TrackMaps } from './track-maps';

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

describe('TrackMaps', () => {
	let fixture: ComponentFixture<TrackMaps>;
	let store: Record<string, unknown>;

	const button = (name: string): HTMLButtonElement => {
		const match = [...fixture.nativeElement.querySelectorAll('button')].find(
			(item) => item.textContent?.trim().includes(name),
		) as HTMLButtonElement | undefined;
		if (!match) throw new Error(`Button not found: ${name}`);
		return match;
	};
	const fill = (selector: string, value: string): void => {
		const input = fixture.nativeElement.querySelector(
			selector,
		) as HTMLInputElement;
		input.value = value;
		input.dispatchEvent(new Event('input'));
		fixture.detectChanges();
	};
	const selectMain = (): void => {
		button('Main').click();
		fixture.detectChanges();
	};

	beforeEach(async () => {
		const selectedLayoutId = signal<string | null>(null);
		store = {
			layouts: signal([layout]),
			canManage: signal(true),
			selectedLayoutId,
			version: signal<TrackMapVersion | null>(null),
			busy: signal(false),
			error: signal(''),
			message: signal(''),
			readError: signal(''),
			loading: signal(false),
			openLayout: vi.fn((id: string) => selectedLayoutId.set(id)),
			createLayout: vi.fn(),
			createDraft: vi.fn(),
			saveDraft: vi.fn(),
			renameLayout: vi.fn(),
			retireLayout: vi.fn(),
			refresh: vi.fn(),
		};
		await TestBed.configureTestingModule({
			imports: [TrackMaps],
			providers: [{ provide: TrackMapStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMaps);
		fixture.detectChanges();
	});
	afterEach(() => TestBed.resetTestingModule());

	it('creates and selects layouts, then creates a draft and renames it', () => {
		fill('#new-layout', ' New layout ');
		button('Create').click();
		expect(store['createLayout']).toHaveBeenCalledWith({ name: 'New layout' });
		selectMain();
		expect(store['openLayout']).toHaveBeenCalledWith(layout.id);
		button('New draft').click();
		fill('input[aria-label="Layout name"]', 'Renamed');
		button('Rename').click();
		expect(store['createDraft']).toHaveBeenCalledWith({
			layoutId: layout.id,
			sourceVersionId: undefined,
		});
		expect(store['renameLayout']).toHaveBeenCalledWith({ name: 'Renamed' });
	});

	it('renders empty and error states and ignores blank names', () => {
		button('Create').click();
		expect(store['createLayout']).not.toHaveBeenCalled();
		selectMain();
		fill('input[aria-label="Layout name"]', '  ');
		button('Rename').click();
		expect(store['renameLayout']).not.toHaveBeenCalled();
		const layouts = store['layouts'] as ReturnType<
			typeof signal<TrackLayout[]>
		>;
		layouts.set([
			{ ...layout, mapVersions: [] },
			{ ...layout, id: 'layout-2', name: 'Second', mapVersions: [] },
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('map versions');
		layouts.set([]);
		(store['selectedLayoutId'] as ReturnType<typeof signal<string | null>>).set(
			null,
		);
		(store['readError'] as ReturnType<typeof signal<string>>).set(
			'Load failed',
		);
		(store['message'] as ReturnType<typeof signal<string>>).set('Saved');
		(store['error'] as ReturnType<typeof signal<string>>).set(
			'Mutation failed',
		);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Choose a layout to begin',
		);
		expect(fixture.nativeElement.textContent).toContain('Load failed');
		expect(fixture.nativeElement.textContent).toContain('Mutation failed');
	});

	it('starts a new draft from the latest approved version', () => {
		(store['layouts'] as ReturnType<typeof signal<TrackLayout[]>>).set([
			{
				...layout,
				mapVersions: [
					{ ...layout.mapVersions[0], status: 'approved' as const },
				],
			},
		]);
		fixture.detectChanges();
		selectMain();
		button('New draft').click();
		expect(store['createDraft']).toHaveBeenCalledWith({
			layoutId: layout.id,
			sourceVersionId: version.id,
		});
	});

	it('keeps the selected workflow mounted during a layout refresh', () => {
		selectMain();
		(store['layouts'] as ReturnType<typeof signal<TrackLayout[]>>).set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Main');
	});

	it('keeps Owner mutation controls private for ordinary users', () => {
		selectMain();
		(store['canManage'] as ReturnType<typeof signal<boolean>>).set(false);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Track reference');
		expect(fixture.nativeElement.textContent).not.toContain('New layout');
		expect(fixture.nativeElement.textContent).not.toContain('Geometry studio');
		expect(fixture.nativeElement.textContent).toContain(
			'Owner draft tools remain private',
		);
	});

	it('renders retired layouts as read-only and locks selection while busy', () => {
		(store['layouts'] as ReturnType<typeof signal<TrackLayout[]>>).set([
			{ ...layout, status: 'retired' },
		]);
		fixture.detectChanges();
		selectMain();
		(store['busy'] as ReturnType<typeof signal<boolean>>).set(true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Retired Track layouts are read-only.',
		);
		expect(fixture.nativeElement.textContent).not.toContain('Geometry studio');
		expect(button('Main').disabled).toBe(true);
	});

	it('wires save, retire, and retry intents through rendered controls', () => {
		selectMain();
		(store['version'] as ReturnType<typeof signal<TrackMapVersion | null>>).set(
			version,
		);
		fixture.detectChanges();
		button('Save draft geometry').click();
		button('Retire layout').click();
		expect(store['saveDraft']).toHaveBeenCalledWith({ corners: [] });
		expect(store['retireLayout']).toHaveBeenCalledOnce();
		(store['readError'] as ReturnType<typeof signal<string>>).set('Retry');
		fixture.detectChanges();
		button('Try again').click();
		expect(store['refresh']).toHaveBeenCalledOnce();
	});
});
