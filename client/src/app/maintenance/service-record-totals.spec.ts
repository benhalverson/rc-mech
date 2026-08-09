import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { ServiceRecord } from './maintenance.models';
import { ServiceRecordTotals } from './service-record-totals';
import { ServiceRecordStore } from './service-record-store';

const record: ServiceRecord = {
	id: 'record-1',
	carId: 'car-1',
	performedAt: '2026-08-09T12:30:00.000Z',
	description: 'Work',
	cost: 12.5,
	currency: 'USD',
};

const store = { records: signal<ServiceRecord[]>([]) };

describe('ServiceRecordTotals', () => {
	let fixture: ComponentFixture<ServiceRecordTotals>;

	beforeEach(async () => {
		store.records.set([]);
		await TestBed.configureTestingModule({
			imports: [ServiceRecordTotals],
			providers: [{ provide: ServiceRecordStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ServiceRecordTotals);
		fixture.detectChanges();
	});

	it('totals visible records by currency and omits empty totals', () => {
		expect(fixture.nativeElement.textContent.trim()).toBe('');
		store.records.set([
			record,
			{ ...record, id: 'second', cost: 2, currency: null },
			{ ...record, id: 'cad', cost: 3, currency: 'CAD' },
			{ ...record, id: 'no-cost', cost: null },
			{ ...record, id: 'deleted', deletedAt: '2026-08-10', cost: 20 },
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('USD 14.50');
		expect(fixture.nativeElement.textContent).toContain('CAD 3.00');
		expect(fixture.nativeElement.textContent).not.toContain('34.50');

		fixture.componentRef.setInput('filter', 'deleted');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('USD 20.00');
	});
});
