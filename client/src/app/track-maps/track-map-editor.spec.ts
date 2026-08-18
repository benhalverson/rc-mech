import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type {
	SaveTrackMapDraftCommand,
	SelectTrackMapFrameCommand,
	TrackMapRecording,
	TrackMapVersion,
} from './track-map.models';
import { TrackMapEditor } from './track-map-editor';

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
const recording: TrackMapRecording = {
	id: 'recording-1',
	fileName: 'Main.mov',
	byteCount: 1_000,
	durationMs: 5_000,
	width: 1_920,
	height: 1_080,
};

describe('TrackMapEditor', () => {
	let fixture: ComponentFixture<TrackMapEditor>;
	let component: TrackMapEditor;

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
	const labelled = <T extends HTMLInputElement | HTMLSelectElement>(
		name: string,
		tagName: 'input' | 'select',
	): T => {
		const label = [...fixture.nativeElement.querySelectorAll('label')].find(
			(item) => item.textContent?.trim().startsWith(name),
		) as HTMLLabelElement | undefined;
		const control = label?.querySelector(tagName) as T | null | undefined;
		if (!control) throw new Error(`Control not found: ${name}`);
		return control;
	};
	const choose = (control: HTMLSelectElement, value: string): void => {
		control.value = value;
		control.dispatchEvent(new Event('input'));
		control.dispatchEvent(new Event('change'));
		fixture.detectChanges();
	};
	const canvas = (): HTMLButtonElement =>
		fixture.nativeElement.querySelector('button.track-canvas-button');
	const setCanvasBounds = (
		left: number,
		top: number,
		width: number,
		height: number,
	): void => {
		Object.defineProperty(canvas(), 'getBoundingClientRect', {
			configurable: true,
			value: () => ({ left, top, width, height }),
		});
	};
	const press = (key: string, shiftKey = false): void => {
		canvas().dispatchEvent(
			new KeyboardEvent('keydown', {
				key,
				shiftKey,
				bubbles: true,
				cancelable: true,
			}),
		);
		fixture.detectChanges();
	};
	const clickCanvas = (clientX: number, clientY: number): void => {
		canvas().dispatchEvent(
			new MouseEvent('click', { clientX, clientY, bubbles: true }),
		);
		fixture.detectChanges();
	};
	const savedCommands = (): SaveTrackMapDraftCommand[] => {
		const saved: SaveTrackMapDraftCommand[] = [];
		component.saveRequested.subscribe((command) => saved.push(command));
		return saved;
	};
	const frameCommands = (): SelectTrackMapFrameCommand[] => {
		const selected: SelectTrackMapFrameCommand[] = [];
		component.frameRequested.subscribe((command) => selected.push(command));
		return selected;
	};

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

	it('edits identity and directions through rendered Signal Form controls', () => {
		const saved = savedCommands();
		button('Add corner').click();
		fixture.detectChanges();
		press('ArrowRight');
		fill('#corner-key', 'turn-1');
		expect(fixture.nativeElement.textContent).toContain(
			'Corner key “turn-1” is duplicated.',
		);
		fill('#corner-key', 'turn-2');
		fill('#corner-name', 'Hairpin');
		choose(labelled('Entry', 'select'), 'reverse');
		choose(labelled('Exit', 'select'), 'reverse');
		const height = labelled<HTMLInputElement>('Height', 'input');
		height.value = '2';
		height.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Corner view must be a positive rectangle inside the Track view.',
		);
		height.value = '0.3';
		height.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		(
			fixture.nativeElement.querySelector(
				'button.alloy-control-primary',
			) as HTMLButtonElement
		).click();
		expect(saved[0]?.corners[1]).toMatchObject({
			key: 'turn-2',
			name: 'Hairpin',
			entryGate: { direction: 'reverse' },
			exitGate: { direction: 'reverse' },
			cornerView: { height: 0.3 },
		});
	});

	it('guides recording and timestamp selection before revealing the frame', () => {
		const selected = frameCommands();
		fixture.componentRef.setInput('version', {
			...version,
			referenceFrame: null,
			corners: [],
		});
		fixture.componentRef.setInput('recordings', [recording]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Main.mov');
		expect(component['frameUrl']()).toBe('');
		expect(button('Use this frame').disabled).toBe(true);
		fixture.componentRef.setInput('busy', true);
		fixture.detectChanges();
		expect(button('Extracting frame…').disabled).toBe(true);
		fixture.componentRef.setInput('busy', false);
		fixture.detectChanges();
		choose(
			fixture.nativeElement.querySelector('#recording-select'),
			recording.id,
		);
		fill('#frame-timestamp', '1250');
		button('Use this frame').click();
		expect(selected).toEqual([
			{ raceVideoId: recording.id, timestampMs: 1_250 },
		]);
		fill('#frame-timestamp', '5000');
		expect(button('Use this frame').disabled).toBe(true);
		fill('#frame-timestamp', '-1');
		fill('#frame-timestamp', 'not-a-number');
		component['selectRecording']('');
		component['selectFrame']();
		expect(selected).toHaveLength(1);
	});

	it('preserves same-revision edits and rebases on new revisions and versions', () => {
		button('Add corner').click();
		fixture.componentRef.setInput('version', { ...version, corners: [] });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Turn 2');
		fixture.componentRef.setInput('version', {
			...version,
			stateVersion: 2,
			updatedAt: '2026-01-02',
			corners: [{ ...version.corners[0], name: 'Canonical name' }],
		});
		fixture.detectChanges();
		expect(
			(fixture.nativeElement.querySelector('#corner-name') as HTMLInputElement)
				.value,
		).toBe('Canonical name');
		fixture.componentRef.setInput('version', {
			...version,
			id: 'version-2',
			corners: [],
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).not.toContain('Canonical name');
	});

	it('approves only saved, nonempty, valid draft geometry', () => {
		let approvals = 0;
		const saved = savedCommands();
		component.approveRequested.subscribe(() => (approvals += 1));
		expect(button('Approve version').disabled).toBe(false);
		button('Approve version').click();
		expect(approvals).toBe(1);
		fill('#corner-name', 'Unsaved name');
		expect(button('Approve version').disabled).toBe(true);
		expect(fixture.nativeElement.textContent).toContain(
			'Save the current geometry before approval.',
		);
		button('Save draft').click();
		fixture.componentRef.setInput('version', {
			...version,
			stateVersion: 2,
			updatedAt: '2026-01-02',
			corners: saved[0]?.corners ?? [],
		});
		fixture.detectChanges();
		expect(button('Approve version').disabled).toBe(false);
		button('Approve version').click();
		expect(approvals).toBe(2);
		fixture.componentRef.setInput('version', {
			...version,
			status: 'approved',
		});
		fixture.detectChanges();
		expect(button('Approve version').disabled).toBe(true);
	});

	it('allocates unused keys and ordered positions after rendered removal', () => {
		const saved = savedCommands();
		button('Add corner').click();
		fixture.detectChanges();
		choose(fixture.nativeElement.querySelector('#corner-select'), 'turn-1');
		button('Remove corner').click();
		button('Add corner').click();
		fixture.detectChanges();
		button('Save draft').click();
		expect(saved[0]?.corners.map(({ key, order }) => ({ key, order }))).toEqual(
			[
				{ key: 'turn-2', order: 1 },
				{ key: 'turn-1', order: 2 },
			],
		);
	});

	it('moves the selected gate point by keyboard and pointer', () => {
		const saved = savedCommands();
		choose(
			fixture.nativeElement.querySelector(
				'select[aria-label="Geometry target"]',
			),
			'entryStart',
		);
		choose(
			fixture.nativeElement.querySelector(
				'select[aria-label="Geometry target"]',
			),
			'exitStart',
		);
		expect(fixture.nativeElement.textContent).toContain('Drawing: Exit gate');
		choose(
			fixture.nativeElement.querySelector(
				'select[aria-label="Geometry target"]',
			),
			'entryStart',
		);
		canvas().focus();
		expect(document.activeElement).toBe(canvas());
		press('ArrowRight', true);
		setCanvasBounds(0, 0, 640, 360);
		clickCanvas(320, 180);
		button('Save draft').click();
		expect(saved[0]?.corners[0]?.entryGate.start).toEqual({ x: 0.5, y: 0.5 });
	});

	it('adjusts Corner-view position and size by keyboard and pointer', () => {
		const saved = savedCommands();
		const target = fixture.nativeElement.querySelector(
			'select[aria-label="Geometry target"]',
		) as HTMLSelectElement;
		choose(target, 'viewPosition');
		press('ArrowLeft');
		press('ArrowUp');
		setCanvasBounds(100, 100, 100, 100);
		clickCanvas(120, 130);
		choose(target, 'viewSize');
		press('ArrowRight');
		press('ArrowDown');
		clickCanvas(180, 190);
		expect(fixture.nativeElement.textContent).not.toContain(
			'Geometry needs attention',
		);
		button('Save draft').click();
		const view = saved[0]?.corners[0]?.cornerView;
		expect(view?.x).toBeCloseTo(0.2);
		expect(view?.y).toBeCloseTo(0.3);
		expect(view?.width).toBeCloseTo(0.6);
		expect(view?.height).toBeCloseTo(0.6);
	});

	it('keeps invalid, busy, irrelevant-key, and empty states safe', () => {
		const saved = savedCommands();
		press('PageDown');
		fixture.componentRef.setInput('version', {
			...version,
			id: 'version-invalid',
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
		for (const control of fixture.nativeElement.querySelectorAll(
			'input, select',
		))
			expect((control as HTMLInputElement | HTMLSelectElement).disabled).toBe(
				true,
			);
		(
			fixture.nativeElement.querySelector(
				'button.alloy-control-primary',
			) as HTMLButtonElement
		).click();
		expect(saved).toEqual([]);
		fixture.componentRef.setInput('busy', false);
		fixture.componentRef.setInput('version', { ...version, corners: [] });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Add and save at least one valid Corner before approval.',
		);
		expect(canvas().disabled).toBe(true);
		button('Add corner').click();
		fixture.detectChanges();
		button('Remove corner').click();
		fixture.detectChanges();
		expect(canvas().disabled).toBe(true);
		fixture.componentRef.setInput('version', null);
		fixture.detectChanges();
		expect(button('Add corner').disabled).toBe(true);
	});
});
