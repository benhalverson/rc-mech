import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CurrentSetupChange,
	CurrentSetupReadoutRow,
	CurrentSetupSnapshot,
} from './current-setup.models';
import { CurrentSetupStore } from './current-setup-store';
import { CurrentSetup } from './current-setup';

const setup: CurrentSetupSnapshot = {
	id: 'setup-1',
	carId: 'car-1',
	name: 'Long clay baseline',
	current: true,
	context: {
		track: 'Track with a long descriptive name',
		condition: 'Dry and grooved',
		recordedAt: '2026-08-09T00:00:00.000Z',
	},
	sections: {
		vehicle: {},
		drivetrain: {},
		electronics: {},
		tires: {},
		shocks: {},
		frontSuspension: {},
		rearSuspension: {},
		notes: {},
	},
	copiedFromSetupId: 'setup-0',
};

class FakeCurrentSetupStore {
	readonly current = signal<CurrentSetupSnapshot | null>(null);
	readonly loading = signal(false);
	readonly failure = signal<{
		message: string;
		retryable: boolean;
	} | null>(null);
	readonly priorityRows = signal<readonly CurrentSetupReadoutRow[]>([]);
	readonly remainingRows = signal<readonly CurrentSetupReadoutRow[]>([]);
	readonly changes = signal<readonly CurrentSetupChange[]>([]);
	readonly retry = vi.fn();
}

describe('CurrentSetup', () => {
	let fixture: ComponentFixture<CurrentSetup>;
	let store: FakeCurrentSetupStore;

	beforeEach(async () => {
		store = new FakeCurrentSetupStore();
		await TestBed.configureTestingModule({
			imports: [CurrentSetup],
			providers: [
				provideRouter([]),
				{ provide: CurrentSetupStore, useValue: store },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(CurrentSetup);
		fixture.componentRef.setInput('carId', 'car-1');
	});

	afterEach(() => TestBed.resetTestingModule());

	const detect = (): HTMLElement => {
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	it('renders the focused active and archived no-current states', () => {
		let root = detect();
		expect(root.textContent).toContain('No current setup');
		expect(root.textContent).toContain('Record setup');
		expect(root.textContent).toContain('Import setup');
		expect(root.querySelectorAll('a')).toHaveLength(2);
		for (const link of root.querySelectorAll('a'))
			expect(link.getAttribute('href')).toBe('/garage/car-1/setups');

		fixture.componentRef.setInput('archived', true);
		root = detect();
		expect(root.textContent).not.toContain('Record setup');
		expect(root.textContent).toContain('View setup history');
		expect(root.querySelectorAll('a')).toHaveLength(1);
	});

	it('renders loading, retryable failure, and terminal failure states', () => {
		store.loading.set(true);
		let root = detect();
		expect(root.querySelector('[role="status"]')?.textContent).toContain(
			'Reading the current setup',
		);

		store.loading.set(false);
		store.failure.set({ message: 'Setup failed.', retryable: true });
		root = detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'Setup failed',
		);
		(root.querySelector('button') as HTMLButtonElement).click();
		expect(store.retry).toHaveBeenCalledOnce();

		store.failure.set({ message: 'Session expired.', retryable: false });
		root = detect();
		expect(root.querySelector('[role="alert"] button')).toBeNull();
	});

	it('renders priority values, changes, and every remaining setup value', () => {
		store.current.set(setup);
		store.priorityRows.set([
			{ id: 'ride-height', label: 'Ride height', value: '12 mm' },
			{
				id: 'camber',
				label: 'Camber',
				value: 'Front · -1° / Rear · Not recorded',
			},
		]);
		store.changes.set([
			{
				id: 'vehicle.rideHeight',
				label: 'Vehicle · Ride height',
				previousValue: '11 mm',
				currentValue: '12 mm',
			},
		]);
		store.remainingRows.set([
			{
				id: 'notes.setupNotes',
				label: 'Notes · Setup notes',
				value:
					'A very long note that must remain readable at large text sizes.',
			},
			{
				id: 'tires.rear',
				label: 'Tires · Rear',
				value: 'Not recorded',
			},
		]);
		const root = detect();
		expect(root.textContent).toContain('Long clay baseline');
		expect(root.textContent).toContain('Aug 9, 2026');
		expect(
			root.querySelectorAll('[aria-label="Priority setup values"] > div'),
		).toHaveLength(2);
		expect(root.textContent).toContain('Front · -1° / Rear · Not recorded');
		expect(root.textContent).toContain('Changes from previous');
		expect(root.textContent).toContain('11 mm → 12 mm');
		expect(root.textContent).toContain('Remaining setup');
		expect(root.textContent).toContain('A very long note');
		expect(
			[...root.querySelectorAll('dd')].filter((value) =>
				value.textContent?.includes('Not recorded'),
			),
		).toHaveLength(2);
		expect(root.textContent).not.toContain('diff');
		expect(root.querySelector('a')?.textContent).toContain('Open setup');
	});

	it('keeps archived setup values visible and removes mutation affordances', () => {
		store.current.set({ ...setup, context: {} });
		fixture.componentRef.setInput('archived', true);
		const root = detect();
		expect(root.textContent).toContain('Track not recorded');
		expect(root.textContent).toContain('Condition not recorded');
		expect(root.textContent).toContain('Date not recorded');
		expect(root.textContent).toContain('Archived record');
		expect(root.querySelector('a')).toBeNull();
		expect(root.textContent).not.toContain('Changes from previous');
		expect(root.textContent).not.toContain('Remaining setup');
	});
});
