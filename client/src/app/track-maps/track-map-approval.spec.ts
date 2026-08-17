import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackCorner, TrackMapVersion } from './track-map.models';
import { TrackMapApproval } from './track-map-approval';

const corner: TrackCorner = {
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
	corners: [corner],
};

describe('TrackMapApproval', () => {
	let fixture: ComponentFixture<TrackMapApproval>;
	let component: TrackMapApproval;
	const button = (): HTMLButtonElement =>
		fixture.nativeElement.querySelector('button');

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [TrackMapApproval],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMapApproval);
		component = fixture.componentInstance;
		fixture.detectChanges();
	});
	afterEach(() => TestBed.resetTestingModule());

	it('approves only a saved, valid, nonempty draft', () => {
		let approvals = 0;
		component.approveRequested.subscribe(() => (approvals += 1));
		expect(button().disabled).toBe(true);
		expect(fixture.nativeElement.textContent).toContain(
			'Add and save at least one valid Corner before approval.',
		);
		expect(component['dirty']()).toBe(false);

		fixture.componentRef.setInput('version', version);
		fixture.componentRef.setInput('corners', version.corners);
		fixture.detectChanges();
		expect(button().disabled).toBe(false);
		button().click();
		expect(approvals).toBe(1);

		fixture.componentRef.setInput('corners', [{ ...corner, name: 'Changed' }]);
		fixture.detectChanges();
		expect(button().disabled).toBe(true);
		expect(fixture.nativeElement.textContent).toContain(
			'Save the current geometry before approval.',
		);

		fixture.componentRef.setInput('corners', version.corners);
		fixture.componentRef.setInput('valid', false);
		fixture.detectChanges();
		expect(button().disabled).toBe(true);
		expect(fixture.nativeElement.textContent).toContain(
			'Resolve every geometry error before approval.',
		);
	});

	it('locks approval while busy or after the draft lifecycle ends', () => {
		fixture.componentRef.setInput('version', version);
		fixture.componentRef.setInput('corners', version.corners);
		fixture.componentRef.setInput('busy', true);
		fixture.detectChanges();
		expect(button().disabled).toBe(true);
		fixture.componentRef.setInput('busy', false);
		fixture.componentRef.setInput('version', {
			...version,
			status: 'approved',
		});
		fixture.detectChanges();
		expect(button().disabled).toBe(true);
	});
});
