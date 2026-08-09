import { describe, expect, it } from 'vitest';
import type { ConsumableEntry, MaintenanceReport } from '../maintenance.models';
import {
	buildTireReport,
	consumableEntryIsReadOnly,
	mergeTireReport,
	spendLabel,
	visibleConsumableEntries,
} from './consumable.rules';

describe('consumable rules', () => {
	it('describes empty history and preserves local data without a server report', () => {
		const report = buildTireReport([]);
		expect(report.front.latest).toBeNull();
		expect(report.front.averageDays).toBeNull();
		expect(report.spend.combined).toBe(0);
		expect(report.fluidEntries).toEqual([]);
		expect(mergeTireReport(report, undefined)).toBe(report);
	});

	it('merges canonical frequency and multi-currency spend from the server', () => {
		const server: MaintenanceReport = {
			tires: {
				frequency: {
					front: { eventCount: 2, averageIntervalDays: 10 },
					rear: { eventCount: 2, averageIntervalDays: 12 },
				},
				spend: {
					front: { total: null },
					rear: { total: 40 },
					combined: { total: null },
				},
			},
			fluidHistory: [],
		};
		const report = mergeTireReport(buildTireReport([]), server);

		expect(report.front).toMatchObject({ eventCount: 2, averageDays: 10 });
		expect(report.rear).toMatchObject({ eventCount: 2, averageDays: 12 });
		expect(report.spend.front).toBeNull();
		expect(report.spend.combined).toBeNull();
		expect(spendLabel(report.spend.combined)).toBe('Multiple currencies');
		expect(spendLabel(report.spend.rear)).toBe('$40.00');
	});

	it('calculates independent axle frequency, details, spend, and missing data', () => {
		const report = buildTireReport([
			tire('both-new', '2026-08-21', 'both', '', 30, 'Rear newer', 40),
			tire('front-old', '2026-08-01', 'front', 'Front older', 20),
			tire(
				'rear-old',
				'2026-08-01',
				'rear',
				undefined,
				undefined,
				'Rear older',
			),
		]);

		expect(report.front.latest?.id).toBe('both-new');
		expect(report.rear.latest?.id).toBe('both-new');
		expect(report.front.averageDays).toBe(20);
		expect(report.rear.averageDays).toBe(20);
		expect(report.front.missingDetails).toBe(true);
		expect(report.rear.missingDetails).toBe(false);
		expect(report.spend).toMatchObject({
			front: 50,
			rear: 40,
			combined: 90,
			missingCostEntries: 1,
		});
	});

	it('keeps active fluid history sorted and ignores archived report entries', () => {
		const report = buildTireReport([
			fluid('fluid-old', '2026-08-01'),
			fluid('fluid-new', '2026-08-02'),
			{ ...fluid('fluid-archived', '2026-08-03'), deletedAt: '2026-08-04' },
			{ ...tire('tire-archived', '2026-08-04', 'front'), deletedAt: 'x' },
		]);

		expect(report.fluidEntries.map((entry) => entry.id)).toEqual([
			'fluid-new',
			'fluid-old',
		]);
		expect(report.front.eventCount).toBe(0);
	});

	it('filters active and archived entries and identifies read-only history', () => {
		const active = fluid('active', '2026-08-01');
		const archived = { ...active, id: 'archived', deletedAt: 'x' };
		expect(visibleConsumableEntries([active, archived], 'active')).toEqual([
			active,
		]);
		expect(visibleConsumableEntries([active, archived], 'archived')).toEqual([
			archived,
		]);
		expect(consumableEntryIsReadOnly(active, [])).toBe(false);
		expect(consumableEntryIsReadOnly(archived, [])).toBe(true);
		expect(
			consumableEntryIsReadOnly(active, [
				{ id: 'car-1', name: 'Buggy', archivedAt: 'x' },
			]),
		).toBe(true);
	});
});

function tire(
	id: string,
	performedAt: string,
	axle: 'front' | 'rear' | 'both',
	frontDetails?: string,
	frontCost?: number,
	rearDetails?: string,
	rearCost?: number,
): ConsumableEntry {
	return {
		id,
		carId: 'car-1',
		kind: 'tires',
		performedAt: `${performedAt}T00:00:00.000Z`,
		axle,
		frontDetails,
		frontCost,
		rearDetails,
		rearCost,
	};
}

function fluid(id: string, performedAt: string): ConsumableEntry {
	return {
		id,
		carId: 'car-1',
		kind: 'shock-fluid',
		performedAt: `${performedAt}T00:00:00.000Z`,
		fluidArea: 'front-shocks',
	};
}
