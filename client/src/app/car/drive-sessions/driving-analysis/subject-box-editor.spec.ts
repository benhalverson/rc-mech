import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SubjectBoxEditor } from './subject-box-editor';

const pointerEvent = (
	type: string,
	values: {
		pointerId: number;
		clientX: number;
		clientY: number;
		button?: number;
	},
): Event => {
	const event = new Event(type, { bubbles: true, cancelable: true });
	for (const [key, value] of Object.entries(values))
		Object.defineProperty(event, key, { value });
	return event;
};

describe('SubjectBoxEditor', () => {
	beforeEach(() =>
		TestBed.configureTestingModule({ imports: [SubjectBoxEditor] }),
	);
	afterEach(() => TestBed.resetTestingModule());

	it('publishes equivalent text, numeric, pointer, and keyboard edits', async () => {
		const fixture = TestBed.createComponent(SubjectBoxEditor);
		fixture.componentRef.setInput('editorId', 'seed-one');
		fixture.componentRef.setInput('box', {
			x: 0.25,
			y: 0.4,
			width: 0.08,
			height: 0.06,
		});
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		expect(root.textContent).toContain('25% from the left');
		expect(root.textContent).toContain('40% from the top');
		const box = root.querySelector<HTMLButtonElement>('[data-subject-box]');
		expect(box?.getAttribute('aria-label')).toContain('Use arrow keys to move');

		const width = root.querySelector<HTMLInputElement>('[data-box-width]');
		if (!width) throw new Error('Width input missing');
		width.value = '0.2';
		width.dispatchEvent(new Event('input', { bubbles: true }));
		fixture.detectChanges();
		expect(fixture.componentInstance.box()).toMatchObject({ width: 0.2 });

		box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
		box?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowDown', shiftKey: true }),
		);
		box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
		fixture.detectChanges();
		expect(fixture.componentInstance.box()).toMatchObject({
			x: 0.252,
			y: 0.41,
		});

		const surface = root.querySelector<HTMLElement>('[data-box-surface]');
		if (!surface) throw new Error('Surface missing');
		const bounds = vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		});
		const capture = vi.fn();
		const release = vi.fn();
		Object.assign(surface, {
			setPointerCapture: capture,
			releasePointerCapture: release,
		});
		surface.dispatchEvent(
			pointerEvent('pointerdown', {
				pointerId: 7,
				clientX: 20,
				clientY: 60,
				button: 0,
			}),
		);
		bounds.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			width: 0,
			height: 0,
			toJSON: () => ({}),
		});
		surface.dispatchEvent(
			pointerEvent('pointermove', {
				pointerId: 7,
				clientX: 20,
				clientY: 20,
			}),
		);
		bounds.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		});
		surface.dispatchEvent(
			pointerEvent('pointermove', {
				pointerId: 7,
				clientX: 60,
				clientY: 90,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointerup', {
				pointerId: 7,
				clientX: 60,
				clientY: 90,
			}),
		);
		fixture.detectChanges();
		expect(capture).toHaveBeenCalledWith(7);
		expect(release).toHaveBeenCalledWith(7);
		expect(fixture.componentInstance.box()).toEqual({
			x: 0.2,
			y: 0.6,
			width: 0.4,
			height: 0.3,
		});
	});

	it('clamps every keyboard and numeric path and ignores unrelated pointers', () => {
		const fixture = TestBed.createComponent(SubjectBoxEditor);
		fixture.componentRef.setInput('editorId', 'seed-two');
		fixture.componentRef.setInput('box', {
			x: 0.5,
			y: 0.5,
			width: 0.2,
			height: 0.2,
		});
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		const input = (name: string, value: string) => {
			const control = root.querySelector<HTMLInputElement>(name);
			if (!control) throw new Error(`${name} missing`);
			control.value = value;
			control.dispatchEvent(new Event('input', { bubbles: true }));
			fixture.detectChanges();
		};
		input('[data-box-x]', '-1');
		input('[data-box-y]', '2');
		input('[data-box-height]', '0');
		input('[data-box-width]', 'not-a-number');
		input('[data-box-width]', 'not-a-number');
		expect(fixture.componentInstance.valid()).toBe(false);
		expect(root.textContent).toContain(
			'Enter all four normalized Subject-box coordinates',
		);
		expect(fixture.componentInstance.box()).toEqual({
			x: 0,
			y: 0.8,
			width: 0.2,
			height: 0.005,
		});
		input('[data-box-width]', '0.2');
		expect(fixture.componentInstance.valid()).toBe(true);

		const box = root.querySelector<HTMLButtonElement>('[data-subject-box]');
		box?.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
		box?.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowUp', shiftKey: true }),
		);
		const beforePointer = fixture.componentInstance.box();
		box?.dispatchEvent(
			pointerEvent('pointerdown', {
				pointerId: 1,
				clientX: 1,
				clientY: 1,
				button: 0,
			}),
		);
		expect(fixture.componentInstance.box()).toEqual(beforePointer);

		const surface = root.querySelector<HTMLElement>('[data-box-surface]');
		if (!surface) throw new Error('Surface missing');
		const bounds = vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 0,
			bottom: 0,
			width: 0,
			height: 0,
			toJSON: () => ({}),
		});
		Object.assign(surface, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		for (const event of [
			pointerEvent('pointermove', { pointerId: 9, clientX: 0, clientY: 0 }),
			pointerEvent('pointerup', { pointerId: 9, clientX: 0, clientY: 0 }),
			pointerEvent('pointerdown', {
				pointerId: 9,
				clientX: 0,
				clientY: 0,
				button: 1,
			}),
			pointerEvent('pointerdown', {
				pointerId: 9,
				clientX: 0,
				clientY: 0,
				button: 0,
			}),
		])
			surface.dispatchEvent(event);
		bounds.mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		});
		surface.dispatchEvent(
			pointerEvent('pointerdown', {
				pointerId: 9,
				clientX: 100,
				clientY: 100,
				button: 0,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointermove', {
				pointerId: 8,
				clientX: 20,
				clientY: 20,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointerup', {
				pointerId: 8,
				clientX: 20,
				clientY: 20,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointermove', {
				pointerId: 9,
				clientX: 20,
				clientY: 30,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointercancel', {
				pointerId: 9,
				clientX: 20,
				clientY: 30,
			}),
		);
		fixture.detectChanges();
		expect(fixture.componentInstance.box()).toEqual({
			x: 0.2,
			y: 0.3,
			width: 0.795,
			height: 0.695,
		});
		expect(fixture.componentInstance.valid()).toBe(true);
	});

	it('keeps arbitrary pointer precision valid for every numeric input', () => {
		const fixture = TestBed.createComponent(SubjectBoxEditor);
		fixture.componentRef.setInput('editorId', 'arbitrary-pointer');
		fixture.componentRef.setInput('box', {
			x: 0.45,
			y: 0.45,
			width: 0.1,
			height: 0.08,
		});
		fixture.detectChanges();
		const root = fixture.nativeElement as HTMLElement;
		const surface = root.querySelector<HTMLElement>('[data-box-surface]');
		if (!surface) throw new Error('Surface missing');
		vi.spyOn(surface, 'getBoundingClientRect').mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		});
		Object.assign(surface, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});
		surface.dispatchEvent(
			pointerEvent('pointerdown', {
				pointerId: 12,
				clientX: 23.7,
				clientY: 58.3,
				button: 0,
			}),
		);
		surface.dispatchEvent(
			pointerEvent('pointermove', {
				pointerId: 12,
				clientX: 68.8,
				clientY: 91.6,
			}),
		);
		fixture.detectChanges();

		expect(fixture.componentInstance.box()).toEqual({
			x: 0.237,
			y: 0.583,
			width: 0.451,
			height: 0.333,
		});
		expect(
			Array.from(
				root.querySelectorAll<HTMLInputElement>(
					'input[data-box-x], input[data-box-y], input[data-box-width], input[data-box-height]',
				),
			).every((input) => input.checkValidity()),
		).toBe(true);
	});
});
