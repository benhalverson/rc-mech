import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { SetupImportReview } from './setup-import-review';
import type { SoDialedImportPreview } from './setup-snapshot';

const preview = (
	carIdentity: SoDialedImportPreview['carIdentity'] = {
		name: 'Named buggy',
		make: 'Associated',
		model: 'B7',
	},
): SoDialedImportPreview => ({
	draftId: 'draft-1',
	source: {},
	carIdentity,
	context: { track: 'Home', condition: 'Dry' },
	sections: {
		vehicle: { rideHeight: '22mm' },
		drivetrain: { motor: '13.5T' },
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	uncertainValues: { caster: true },
	unmappedValues: { diagram: true },
	rawValues: {},
	duplicate: { setupId: 'setup-old', name: 'Earlier import' },
});

describe('SetupImportReview', () => {
	let fixture: ComponentFixture<SetupImportReview>;

	beforeEach(async () => {
		await TestBed.configureTestingModule({
			imports: [SetupImportReview],
		}).compileComponents();
		fixture = TestBed.createComponent(SetupImportReview);
		fixture.componentRef.setInput('preview', preview());
		fixture.componentRef.setInput('availableCars', [
			{ id: 'car-1', name: 'Red', make: 'Associated', model: 'B7' },
			{ id: 'car-2', name: 'Blue', make: null, model: null },
		]);
		fixture.componentRef.setInput('selection', { carId: 'car-1' });
		fixture.detectChanges();
	});

	it('renders review evidence and keeps target selection in its Signal Form', () => {
		expect(fixture.nativeElement.textContent).toContain('Earlier import');
		expect(fixture.nativeElement.textContent).toContain('2 mapped values');
		expect(fixture.nativeElement.textContent).toContain('1 uncertain');
		expect(fixture.nativeElement.textContent).toContain('1 unmapped');
		const select = fixture.nativeElement.querySelector(
			'select',
		) as HTMLSelectElement;
		expect(select.value).toBe('car-1');
		select.value = 'car-2';
		select.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		expect(fixture.componentInstance.selection()).toEqual({ carId: 'car-2' });
	});

	it('emits every imported identity fallback', () => {
		const emitted: unknown[] = [];
		fixture.componentInstance.createCarFromImport.subscribe((identity) =>
			emitted.push(identity),
		);
		const button = fixture.nativeElement.querySelector(
			'button',
		) as HTMLButtonElement;
		for (const identity of [
			{ name: 'Named buggy', make: 'Associated', model: 'B7' },
			{ name: '', make: 'Associated', model: 'B7' },
			{},
		]) {
			fixture.componentRef.setInput('preview', preview(identity));
			fixture.detectChanges();
			button.click();
		}
		expect(emitted).toEqual([
			{ name: 'Named buggy', make: 'Associated', model: 'B7' },
			{ name: 'Associated B7', make: 'Associated', model: 'B7' },
			{ name: 'Imported car', make: '', model: '' },
		]);

		fixture.componentRef.setInput('preview', {
			...preview(),
			carIdentity: {},
			duplicate: undefined,
			context: {},
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Unknown make');
		expect(fixture.nativeElement.textContent).toContain('Track not recorded');
		expect(fixture.nativeElement.textContent).not.toContain('Earlier import');
	});
});
