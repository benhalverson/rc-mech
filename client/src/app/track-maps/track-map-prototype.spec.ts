import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { describe, expect, it } from 'vitest';
import { TrackMapPrototype } from './track-map-prototype';

describe('TrackMapPrototype', () => {
	let fixture: ComponentFixture<TrackMapPrototype>;

	const select = (selector: string, value: string): void => {
		const element = fixture.nativeElement.querySelector(
			selector,
		) as HTMLSelectElement;
		element.value = value;
		element.dispatchEvent(new Event('change'));
		fixture.detectChanges();
	};
	const input = (selector: string, value: string): void => {
		const element = fixture.nativeElement.querySelector(
			selector,
		) as HTMLInputElement;
		element.value = value;
		element.dispatchEvent(new Event('input'));
		fixture.detectChanges();
	};

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [TrackMapPrototype],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMapPrototype);
		fixture.detectChanges();
	});

	it('supports the guided recording, frame, and geometry steps in memory', () => {
		const root = fixture.nativeElement as HTMLElement;
		const internals = fixture.componentInstance as unknown as {
			selectCorner(value: string): void;
			selectTarget(value: string): void;
			setTimestamp(value: string): void;
		};
		expect(root.textContent).toContain('Track-map guided flow');
		select('select', 'Club race · heat 3.mp4');
		input('#prototype-time-a', '240');
		select('#prototype-corner', '1');
		select('#prototype-target', 'Corner view');
		input('#prototype-time-a', 'not-a-number');
		internals.setTimestamp('301');
		internals.setTimestamp('not-a-number');
		internals.selectCorner('-1');
		internals.selectCorner('2');
		internals.selectTarget('invalid');
		fixture.detectChanges();
		expect(root.textContent).toContain('301s');
		expect(root.textContent).toContain('Corner view');
		expect(root.textContent).toContain('Approve for analysis');
	});
});
