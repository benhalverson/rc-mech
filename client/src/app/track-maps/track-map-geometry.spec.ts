import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TrackCorner } from './track-map.models';
import { TrackMapGeometry } from './track-map-geometry';

const corner: TrackCorner = {
	key: 'hairpin',
	name: 'Hairpin',
	order: 1,
	entryGate: {
		start: { x: 0.1, y: 0.2 },
		end: { x: 0.2, y: 0.2 },
		direction: 'reverse',
	},
	exitGate: {
		start: { x: 0.3, y: 0.4 },
		end: { x: 0.4, y: 0.4 },
		direction: 'forward',
	},
	cornerView: { x: 0.1, y: 0.1, width: 0.4, height: 0.4 },
};

describe('TrackMapGeometry', () => {
	let fixture: ComponentFixture<TrackMapGeometry>;
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [TrackMapGeometry],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMapGeometry);
		fixture.componentRef.setInput('corners', [corner]);
		fixture.componentRef.setInput('label', 'Reviewed geometry');
		fixture.detectChanges();
	});
	afterEach(() => {
		vi.restoreAllMocks();
		TestBed.resetTestingModule();
	});

	it('renders canonical gates, Corner views, labels, and active handles', () => {
		fixture.componentRef.setInput('activeCorner', corner);
		fixture.detectChanges();
		const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
		expect(svg.getAttribute('role')).toBe('img');
		expect(svg.getAttribute('aria-label')).toBe('Reviewed geometry');
		expect(svg.querySelector('title')?.textContent).toBe('Reviewed geometry');
		expect(svg.querySelectorAll('line')).toHaveLength(2);
		expect(svg.querySelectorAll('circle')).toHaveLength(4);
		expect(svg.querySelector('line')?.getAttribute('x1')).toBe('64');
		expect(svg.querySelector('line')?.getAttribute('y1')).toBe('72');
		expect(svg.textContent).toContain('1 · Hairpin');
	});

	it('stays hidden from accessibility APIs inside the labelled editor button', () => {
		fixture.componentRef.setInput('decorative', true);
		fixture.detectChanges();
		const svg = fixture.nativeElement.querySelector('svg') as SVGElement;
		expect(svg.hasAttribute('role')).toBe(false);
		expect(svg.getAttribute('aria-hidden')).toBe('true');
		expect(svg.hasAttribute('aria-label')).toBe(false);
		expect(svg.querySelectorAll('circle')).toHaveLength(0);
	});

	it('renders temporary duplicate keys without unstable-tracking diagnostics', () => {
		const error = vi
			.spyOn(console, 'error')
			.mockImplementation(() => undefined);
		const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
		fixture.componentRef.setInput('corners', [
			corner,
			{ ...corner, name: 'Duplicate under correction' },
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelectorAll('line')).toHaveLength(4);
		expect(error).not.toHaveBeenCalled();
		expect(warn).not.toHaveBeenCalled();
	});
});
