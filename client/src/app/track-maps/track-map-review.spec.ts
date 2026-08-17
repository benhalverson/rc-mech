import { type ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { TrackMapVersion } from './track-map.models';
import { TrackMapReview } from './track-map-review';

const version: TrackMapVersion = {
	id: 'version-1',
	layoutId: 'layout-1',
	version: 3,
	stateVersion: 4,
	status: 'approved',
	sourceVersionId: null,
	createdBy: 'owner-1',
	createdAt: '2026-01-01',
	updatedAt: '2026-01-02',
	approvedBy: 'owner-1',
	approvedAt: '2026-01-02',
	retiredAt: null,
	corners: [
		{
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
		},
	],
};

describe('TrackMapReview', () => {
	let fixture: ComponentFixture<TrackMapReview>;
	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [TrackMapReview],
		}).compileComponents();
		fixture = TestBed.createComponent(TrackMapReview);
		fixture.componentRef.setInput('version', version);
		fixture.detectChanges();
	});
	afterEach(() => TestBed.resetTestingModule());

	it('renders immutable provenance and exact normalized geometry', () => {
		const text = fixture.nativeElement.textContent as string;
		expect(text).toContain('Version 3 review');
		expect(text).toContain('owner-1');
		expect(text).toContain('0.1, 0.2 → 0.2, 0.2');
		expect(text).toContain('x 0.1, y 0.1, w 0.4, h 0.4');
		expect(
			fixture.nativeElement.querySelector('svg').getAttribute('aria-label'),
		).toContain('version 3');
	});

	it('labels missing approval provenance without inventing it', () => {
		fixture.componentRef.setInput('version', {
			...version,
			status: 'retired',
			approvedBy: null,
			approvedAt: null,
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Not approved');
	});
});
