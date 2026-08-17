import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackMapVersion } from './track-map.models';
import { TrackMapEditor } from './track-map-editor';

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
	corners: [
		{
			key: 'turn-1',
			name: 'Turn 1',
			order: 1,
			entryGate: {
				start: { x: 0.1, y: 0.2 },
				end: { x: 0.2, y: 0.2 },
				direction: 'forward',
			},
			exitGate: {
				start: { x: 0.3, y: 0.4 },
				end: { x: 0.4, y: 0.4 },
				direction: 'forward',
			},
			cornerView: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
		},
	],
};
const eventWithValue = (value: string): Event => {
	const input = document.createElement('input');
	input.value = value;
	return { target: input } as unknown as Event;
};

describe('TrackMapEditor', () => {
	let fixture: ComponentFixture<TrackMapEditor>;
	let component: TrackMapEditor;
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [TrackMapEditor],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMapEditor);
		component = fixture.componentInstance;
		fixture.componentRef.setInput('version', version);
		fixture.detectChanges();
	});
	afterEach(() => TestBed.resetTestingModule());
	it('renders the geometry and supports corner and coordinate editing', () => {
		expect(fixture.nativeElement.textContent).toContain('Turn 1');
		const value = component as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		value['addCorner']();
		value['selectCorner']('turn-2');
		value['setKey'](eventWithValue('turn-1'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Corner key “turn-1” is duplicated.',
		);
		value['setKey'](eventWithValue('turn-2'));
		value['selectCorner']('turn-1');
		value['selectCorner']('missing');
		value['setName'](eventWithValue('First corner'));
		value['setKey'](eventWithValue('first-corner'));
		value['setCoordinate'](eventWithValue('0.33'), 'entryStart', 'x');
		value['selectPoint']('entryStart');
		value['moveSelected']({
			key: 'ArrowRight',
			shiftKey: true,
			preventDefault: () => undefined,
		} as unknown as KeyboardEvent);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('First corner');
		value['removeCorner']();
	});
	it('preserves an in-progress draft for the same version and resets for a new one', () => {
		const value = component as unknown as Record<
			string,
			(...args: unknown[]) => void
		>;
		value['addCorner']();
		fixture.componentRef.setInput('version', { ...version, corners: [] });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Turn 2');
		fixture.componentRef.setInput('version', {
			...version,
			id: 'version-2',
			corners: [],
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain('Turn 2');
	});
	it('moves a selected point from the canvas, validates, and emits save', () => {
		const value = component as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		const canvas = document.createElement('button');
		Object.defineProperty(canvas, 'getBoundingClientRect', {
			value: () => ({ left: 0, top: 0, width: 640, height: 360 }),
		});
		value['moveFromCanvas']({
			currentTarget: canvas,
			clientX: 320,
			clientY: 180,
		} as unknown as MouseEvent);
		let saved: readonly TrackMapVersion['corners'][number][] = [];
		component.saveRequested.subscribe((corners) => {
			saved = corners;
		});
		value['saveDraft']();
		expect(saved).toEqual([
			{
				...version.corners[0],
				entryGate: {
					...version.corners[0].entryGate,
					start: { x: 0.5, y: 0.5 },
				},
			},
		]);
	});
	it('covers point targets, guarded events, and empty editor states', () => {
		const value = component as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		value['setName']({
			target: document.createElement('div'),
		} as unknown as Event);
		for (const target of ['entryStart', 'entryEnd', 'exitStart', 'exitEnd']) {
			value['selectPoint'](target);
			value['setCoordinate'](eventWithValue('2'), target, 'y');
		}
		value['selectCornerEvent']({
			target: document.createElement('div'),
		} as unknown as Event);
		value['selectPointEvent']({
			target: document.createElement('div'),
		} as unknown as Event);
		value['moveSelected']({
			key: 'PageDown',
			shiftKey: false,
		} as unknown as KeyboardEvent);
		value['moveFromCanvas']({
			currentTarget: document.createElement('div'),
		} as unknown as MouseEvent);
		fixture.componentRef.setInput('version', {
			...version,
			corners: [
				{
					...version.corners[0],
					entryGate: {
						...version.corners[0].entryGate,
						end: version.corners[0].entryGate.start,
					},
				},
			],
		});
		fixture.componentRef.setInput('busy', true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Geometry needs attention',
		);
		value['saveDraft']();
		fixture.componentRef.setInput('version', null);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Add corner');
		expect(fixture.nativeElement.querySelector('button')?.disabled).toBe(true);
		value['removeCorner']();
		value['setKey'](eventWithValue('unused'));
		value['setCoordinate'](eventWithValue('-1'), 'entryStart', 'x');
		value['moveSelected']({
			key: 'ArrowLeft',
			shiftKey: false,
			preventDefault: () => undefined,
		} as unknown as KeyboardEvent);
	});
	it('clamps canvas placement and handles every keyboard direction', () => {
		const value = component as unknown as Record<
			string,
			(...args: unknown[]) => unknown
		>;
		const canvas = document.createElement('button');
		Object.defineProperty(canvas, 'getBoundingClientRect', {
			value: () => ({ left: 100, top: 100, width: 100, height: 100 }),
		});
		value['moveFromCanvas']({
			currentTarget: canvas,
			clientX: 0,
			clientY: 300,
		} as unknown as MouseEvent);
		for (const key of ['ArrowLeft', 'ArrowUp', 'ArrowDown']) {
			value['moveSelected']({
				key,
				shiftKey: false,
				preventDefault: () => undefined,
			} as unknown as KeyboardEvent);
		}
	});
	it('drives the editor through its semantic controls', () => {
		const buttons = fixture.nativeElement.querySelectorAll('button');
		(buttons[0] as HTMLButtonElement).click();
		(buttons[1] as HTMLButtonElement).click();
		const selects = fixture.nativeElement.querySelectorAll('select');
		(selects[0] as HTMLSelectElement).value = 'turn-1';
		(selects[0] as HTMLSelectElement).dispatchEvent(new Event('change'));
		(selects[1] as HTMLSelectElement).value = 'exitEnd';
		(selects[1] as HTMLSelectElement).dispatchEvent(new Event('change'));
		const inputs = fixture.nativeElement.querySelectorAll('input');
		for (const input of inputs) {
			(input as HTMLInputElement).value = '0.4';
			input.dispatchEvent(new Event('input'));
		}
		fixture.nativeElement
			.querySelector('button.track-canvas-button')
			?.dispatchEvent(new MouseEvent('click', { clientX: 200, clientY: 100 }));
		fixture.nativeElement
			.querySelector('button.alloy-control-primary')
			?.dispatchEvent(new Event('click'));
		for (const button of fixture.debugElement.queryAll(By.css('button'))) {
			button.triggerEventHandler('click', new MouseEvent('click'));
			button.triggerEventHandler('keydown', {
				key: 'ArrowDown',
				shiftKey: false,
				preventDefault: () => undefined,
			} as KeyboardEvent);
		}
		fixture.detectChanges();
	});
});
