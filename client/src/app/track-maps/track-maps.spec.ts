import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackLayout, TrackMapVersion } from './track-map.models';
import { TrackMapEditor } from './track-map-editor';
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
const eventWithValue = (value: string): Event => {
	const input = document.createElement('input');
	input.value = value;
	return { target: input } as unknown as Event;
};

describe('TrackMaps', () => {
	let fixture: ComponentFixture<TrackMaps>;
	let store: Record<string, unknown>;
	beforeEach(async () => {
		const selectedLayoutId = signal<string | null>(null);
		store = {
			layouts: signal([layout]),
			selectedLayoutId,
			version: signal<TrackMapVersion | null>(null),
			busy: signal(false),
			error: signal(''),
			message: signal(''),
			readError: signal(''),
			loading: signal(false),
			selectLayout: vi.fn((id: string) => selectedLayoutId.set(id)),
			loadVersion: vi.fn(),
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
	it('selects a layout, creates a layout and draft, and renames it', () => {
		const component = fixture.componentInstance as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		component['chooseLayout']('layout-1');
		expect(store['selectLayout']).toHaveBeenCalledWith('layout-1');
		expect(store['loadVersion']).toHaveBeenCalledWith('version-1');
		component['setNewLayoutName'](eventWithValue(' New layout '));
		component['createLayout']();
		component['createDraft']();
		component['setLayoutName'](eventWithValue('Renamed'));
		component['renameLayout']();
		expect(store['createLayout']).toHaveBeenCalledWith('New layout');
		expect(store['createDraft']).toHaveBeenCalledWith('layout-1', undefined);
	});
	it('renders empty and error states and guards blank commands', () => {
		const component = fixture.componentInstance as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		component['chooseLayout']('missing');
		component['createDraft']();
		component['createLayout']();
		component['renameLayout']();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Choose a layout to begin',
		);
		(component['newLayoutName'] as ReturnType<typeof signal<string>>).set('  ');
		(component['layoutName'] as ReturnType<typeof signal<string>>).set('  ');
		component['createLayout']();
		component['renameLayout']();
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
		(store['readError'] as ReturnType<typeof signal<string>>).set(
			'Load failed',
		);
		(store['message'] as ReturnType<typeof signal<string>>).set('Saved');
		(store['error'] as ReturnType<typeof signal<string>>).set(
			'Mutation failed',
		);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Load failed');
		expect(fixture.nativeElement.textContent).toContain('Mutation failed');
	});
	it('starts a new draft from the latest approved version', () => {
		const approvedLayout = {
			...layout,
			mapVersions: [{ ...layout.mapVersions[0], status: 'approved' as const }],
		};
		(store['layouts'] as ReturnType<typeof signal<TrackLayout[]>>).set([
			approvedLayout,
		]);
		const component = fixture.componentInstance as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		component['chooseLayout']('layout-1');
		component['createDraft']();
		expect(store['createDraft']).toHaveBeenCalledWith('layout-1', version.id);
	});
	it('keeps the selected workflow mounted during a layout refresh', () => {
		const component = fixture.componentInstance as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		component['chooseLayout']('layout-1');
		fixture.detectChanges();
		(store['layouts'] as ReturnType<typeof signal<TrackLayout[]>>).set([]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Main');
	});
	it('drives layout controls from the template', () => {
		const layoutButton = fixture.nativeElement.querySelector(
			'aside button',
		) as HTMLButtonElement;
		layoutButton.click();
		fixture.detectChanges();
		(store['version'] as ReturnType<typeof signal<TrackMapVersion | null>>).set(
			version,
		);
		fixture.detectChanges();
		const layoutNameInput = fixture.nativeElement.querySelector(
			'input[aria-label="Layout name"]',
		) as HTMLInputElement;
		layoutNameInput.value = 'Template rename';
		layoutNameInput.dispatchEvent(new Event('input'));
		const newInput = fixture.nativeElement.querySelector(
			'#new-layout',
		) as HTMLInputElement;
		newInput.value = 'From template';
		newInput.dispatchEvent(new Event('input'));
		fixture.nativeElement
			.querySelector('#new-layout + button')
			?.dispatchEvent(new Event('click'));
		fixture.nativeElement
			.querySelector('button.alloy-control-secondary')
			?.dispatchEvent(new Event('click'));
		fixture.detectChanges();
		const component = fixture.componentInstance as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		component['setNewLayoutName']({
			target: document.createElement('div'),
		} as unknown as Event);
		component['setLayoutName']({
			target: document.createElement('div'),
		} as unknown as Event);
		for (const button of fixture.debugElement.queryAll(By.css('button'))) {
			button.triggerEventHandler('click', new Event('click'));
		}
		const editor = fixture.debugElement.query(By.directive(TrackMapEditor));
		(editor.componentInstance as TrackMapEditor).saveRequested.emit(
			version.corners,
		);
		(store['readError'] as ReturnType<typeof signal<string>>).set('Retry');
		fixture.detectChanges();
		fixture.debugElement
			.query(By.css('[role="alert"] button'))
			.triggerEventHandler('click', new Event('click'));
		expect(store['refresh']).toHaveBeenCalled();
		expect(store['saveDraft']).toHaveBeenCalledWith(version.corners);
		fixture.detectChanges();
	});
});
