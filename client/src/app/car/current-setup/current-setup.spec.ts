import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { provideRouter } from '@angular/router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CurrentSetup } from './current-setup';
import type {
	CurrentSetupChange,
	CurrentSetupReadoutRow,
	CurrentSetupSaveOutcome,
	CurrentSetupSnapshot,
	SaveCurrentSetupCommand,
} from './current-setup.models';
import { CurrentSetupStore } from './current-setup-store';
import { SetupChangeEditor } from './setup-change-editor';

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
	updatedAt: '2026-08-09T21:00:00.000Z',
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
	readonly timezone = signal('UTC');
	readonly timezoneReady = signal(true);
	readonly outcome = signal<CurrentSetupSaveOutcome>({
		status: 'idle',
		operation: 'save-current-setup',
		operationId: null,
	});
	readonly pending = signal(false);
	readonly saveError = signal('');
	readonly retry = vi.fn();
	readonly selectCar = vi.fn();
	readonly clearSaveOutcome = vi.fn();
	readonly saveCurrentSetup = vi.fn((_command: SaveCurrentSetupCommand) => {});
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
			{
				id: 'ride-height',
				label: 'Ride height',
				value: '12 mm',
				focusField: 'vehicle.rideHeight',
			},
			{
				id: 'camber',
				label: 'Camber',
				value: 'Front · -1° / Rear · Not recorded',
				focusField: 'frontSuspension.camber',
				segments: [
					{
						label: 'Front camber',
						value: '-1°',
						focusField: 'frontSuspension.camber',
					},
					{
						label: 'Rear camber',
						value: 'Not recorded',
						focusField: 'rearSuspension.camber',
					},
				],
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
				focusField: 'notes.setupNotes',
			},
			{
				id: 'tires.rear',
				label: 'Tires · Rear',
				value: 'Not recorded',
				focusField: 'tires.rear',
			},
		]);
		const root = detect();
		expect(root.textContent).toContain('Long clay baseline');
		expect(root.textContent).toContain('Aug 9, 2026');
		expect(
			root.querySelectorAll('[aria-label="Priority setup values"] > div'),
		).toHaveLength(2);
		expect(root.textContent?.replaceAll('\u00a0', ' ')).toContain(
			'-1° / Not recorded',
		);
		expect(
			root.querySelector(
				'[aria-label="Change setup: Rear camber, Not recorded"]',
			),
		).not.toBeNull();
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
		expect(root.querySelector('a')?.textContent).toContain('Setup history');
	});

	it('starts a copied change at the tapped value and restores focus on cancel', async () => {
		store.current.set(setup);
		store.priorityRows.set([
			{
				id: 'ride-height',
				label: 'Ride height',
				value: '12 mm',
				focusField: 'vehicle.rideHeight',
			},
		]);
		let root = detect();
		const trigger = root.querySelector<HTMLButtonElement>(
			'[data-change-trigger="vehicle.rideHeight"]',
		);
		trigger?.click();
		root = detect();
		await fixture.whenStable();
		expect(root.querySelector('app-setup-change-editor')).not.toBeNull();
		expect(
			root.querySelector<HTMLInputElement>('[data-setup-field="name"]')?.value,
		).toContain('Long clay baseline ·');
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'vehicle.rideHeight',
		);

		root.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
		root = detect();
		await fixture.whenStable();
		expect(root.querySelector('app-setup-change-editor')).toBeNull();
		expect(document.activeElement?.getAttribute('data-change-trigger')).toBe(
			'vehicle.rideHeight',
		);
	});

	it('opens combined readout segments at their own fields', async () => {
		store.current.set(setup);
		store.priorityRows.set([
			{
				id: 'camber',
				label: 'Camber · Front / Rear',
				value: '-1° / -2°',
				focusField: 'frontSuspension.camber',
				segments: [
					{
						label: 'Front camber',
						value: '-1°',
						focusField: 'frontSuspension.camber',
					},
					{
						label: 'Rear camber',
						value: '-2°',
						focusField: 'rearSuspension.camber',
					},
				],
			},
		]);
		let root = detect();
		root
			.querySelector<HTMLButtonElement>(
				'[data-change-trigger="rearSuspension.camber"]',
			)
			?.click();
		root = detect();
		await fixture.whenStable();
		expect(root.querySelector('app-setup-change-editor')).not.toBeNull();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'rearSuspension.camber',
		);
	});

	it('opens from the ordinary action, completes, focuses remaining values, and resets on route change', async () => {
		store.current.set(setup);
		store.remainingRows.set([
			{
				id: 'tires.rear',
				label: 'Tires · Rear',
				value: 'Bars',
				focusField: 'tires.rear',
			},
		]);
		let root = detect();
		root
			.querySelector<HTMLButtonElement>('[data-change-trigger="name"]')
			?.click();
		root = detect();
		await fixture.whenStable();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'name',
		);
		const editor = fixture.debugElement.query(By.directive(SetupChangeEditor))
			.componentInstance as SetupChangeEditor;
		editor.completed.emit();
		root = detect();
		await fixture.whenStable();
		expect(root.querySelector('[role="status"]')?.textContent).toContain(
			'New Current setup saved',
		);
		expect(document.activeElement?.getAttribute('data-change-trigger')).toBe(
			'name',
		);
		(
			fixture.componentInstance as unknown as {
				beginChange(focusField: string): void;
			}
		).beginChange('missing.field');
		root = detect();
		await fixture.whenStable();
		const fallbackEditor = fixture.debugElement.query(
			By.directive(SetupChangeEditor),
		).componentInstance as SetupChangeEditor;
		fallbackEditor.cancelled.emit();
		root = detect();
		await fixture.whenStable();
		expect(document.activeElement?.getAttribute('data-change-trigger')).toBe(
			'name',
		);

		root
			.querySelector<HTMLButtonElement>('[data-change-trigger="tires.rear"]')
			?.click();
		root = detect();
		await fixture.whenStable();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'tires.rear',
		);
		fixture.componentRef.setInput('carId', 'car-2');
		root = detect();
		expect(root.querySelector('app-setup-change-editor')).toBeNull();
		expect(root.textContent).not.toContain('New Current setup saved');
		expect(store.selectCar).toHaveBeenCalledWith('car-2');

		fixture.componentRef.setInput('carId', '');
		detect();
	});

	it('guards change entry without a writable current setup', () => {
		const component = fixture.componentInstance as unknown as {
			beginChange(focusField: string): void;
		};
		component.beginChange('name');
		expect(store.clearSaveOutcome).not.toHaveBeenCalled();

		store.current.set(setup);
		fixture.componentRef.setInput('archived', true);
		detect();
		component.beginChange('name');
		expect(store.clearSaveOutcome).not.toHaveBeenCalled();

		fixture.componentRef.setInput('archived', false);
		store.pending.set(true);
		detect();
		component.beginChange('name');
		expect(store.clearSaveOutcome).not.toHaveBeenCalled();

		store.pending.set(false);
		store.timezoneReady.set(false);
		detect();
		component.beginChange('name');
		expect(store.clearSaveOutcome).not.toHaveBeenCalled();
		expect(
			(fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>(
				'[data-change-trigger="name"]',
			)?.disabled,
		).toBe(true);
	});

	it('keeps archived setup values visible and removes mutation affordances', () => {
		store.current.set({ ...setup, context: {} });
		store.priorityRows.set([
			{
				id: 'ride-height',
				label: 'Ride height',
				value: '12 mm',
				focusField: 'vehicle.rideHeight',
			},
		]);
		store.remainingRows.set([
			{
				id: 'tires.rear',
				label: 'Tires · Rear',
				value: 'Not recorded',
				focusField: 'tires.rear',
			},
		]);
		fixture.componentRef.setInput('archived', true);
		const root = detect();
		expect(root.textContent).toContain('Track not recorded');
		expect(root.textContent).toContain('Condition not recorded');
		expect(root.textContent).toContain('Date not recorded');
		expect(root.textContent).toContain('Archived record');
		expect(root.textContent).toContain('12 mm');
		expect(root.textContent).toContain('Not recorded');
		expect(root.querySelector('[data-change-trigger]')).toBeNull();
		expect(root.querySelector('a')).toBeNull();
		expect(root.textContent).not.toContain('Changes from previous');
		expect(root.textContent).toContain('Remaining setup');
	});
});
