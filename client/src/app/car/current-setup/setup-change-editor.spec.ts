import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
	CurrentSetupSaveOutcome,
	CurrentSetupSnapshot,
	SaveCurrentSetupCommand,
} from './current-setup.models';
import { CurrentSetupStore } from './current-setup-store';
import { setupChangeFormFromSnapshot } from './setup-change.rules';
import { SetupChangeEditor } from './setup-change-editor';

const setup: CurrentSetupSnapshot = {
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay baseline',
	current: true,
	context: { track: 'Club track', condition: 'Dry' },
	sections: {
		vehicle: { rideHeight: '12 mm', weight: '1,510 g' },
		drivetrain: {
			driveType: '2WD',
			gearDiffOil: '7k',
			gearDiffHeight: '3 mm',
		},
		electronics: { esc: 'Stock profile', customTiming: '0°' },
		tires: { front: 'Pins', rear: 'Bars' },
		shocks: {
			frontSpring: 'Blue',
			frontOil: '35 wt',
			rearSpring: 'Green',
			rearOil: '450 cSt',
		},
		frontSuspension: { camber: '-1°', toe: '1 mm out' },
		rearSuspension: {
			camber: '-2°',
			cBlockPill: 'up/in',
			dBlockPill: 'center/in',
		},
		notes: { setupNotes: 'Baseline notes' },
	},
	copiedFromSetupId: null,
	updatedAt: '2026-08-09T21:00:00.000Z',
};

class FakeCurrentSetupStore {
	readonly outcome = signal<CurrentSetupSaveOutcome>({
		status: 'idle',
		operation: 'save-current-setup',
		operationId: null,
	});
	readonly pending = signal(false);
	readonly saveError = signal('');
	readonly saveCurrentSetup = vi.fn((_command: SaveCurrentSetupCommand) => {});
}

describe('SetupChangeEditor', () => {
	let fixture: ComponentFixture<SetupChangeEditor>;
	let store: FakeCurrentSetupStore;

	beforeEach(async () => {
		store = new FakeCurrentSetupStore();
		await TestBed.configureTestingModule({
			imports: [SetupChangeEditor],
			providers: [{ provide: CurrentSetupStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(SetupChangeEditor);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('setup', setup);
		fixture.componentRef.setInput(
			'initialForm',
			setupChangeFormFromSnapshot(
				setup,
				new Date('2026-08-09T21:14:00.000Z'),
				'America/Los_Angeles',
			),
		);
		fixture.componentRef.setInput('initialFocus', 'rearSuspension.cBlockPill');
	});

	afterEach(() => TestBed.resetTestingModule());

	const detect = (): HTMLElement => {
		fixture.detectChanges();
		return fixture.nativeElement as HTMLElement;
	};

	const input = (field: string): HTMLInputElement => {
		const value = (
			fixture.nativeElement as HTMLElement
		).querySelector<HTMLInputElement>(`[data-setup-field="${field}"]`);
		if (!value) throw new Error(`Missing ${field}`);
		return value;
	};

	const change = (field: string, value: string): void => {
		const control = input(field);
		control.value = value;
		control.dispatchEvent(new Event('input', { bubbles: true }));
		fixture.detectChanges();
	};

	it('renders the complete copied form and focuses the tapped physical value', async () => {
		let root = detect();
		await fixture.whenStable();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'rearSuspension.cBlockPill',
		);
		expect(input('name').value).toBe('Clay baseline · Aug 9, 2:14 PM');
		expect(root.querySelectorAll('input[type="radio"]')).toHaveLength(18);
		expect(root.textContent).toContain('C block selected: up/in');
		expect(root.textContent).toContain('D block selected: center/in');
		expect(input('drivetrain.gearDiffOil').value).toBe('7k');
		expect(
			root.querySelector('[data-setup-field="drivetrain.frontDiffOil"]'),
		).toBeNull();
		expect(input('electronics.customTiming').value).toBe('0°');

		change('drivetrain.driveType', '');
		root = detect();
		expect(
			root.querySelector('[data-setup-field="drivetrain.frontDiffOil"]'),
		).not.toBeNull();
		expect(
			root.querySelector('[data-setup-field="drivetrain.gearDiffOil"]'),
		).not.toBeNull();
	});

	it('dispatches one complete save, reflects concurrency, and closes on success', () => {
		const completed = vi.fn();
		fixture.componentInstance.completed.subscribe(completed);
		detect();
		change('vehicle.rideHeight', '14 mm');
		change('drivetrain.driveType', '4WD');
		change('drivetrain.centerSlipper', 'Decoupled');
		const root = detect();
		expect(
			root.querySelector('[data-setup-field="drivetrain.centerDiffOil"]'),
		).toBeNull();
		const rearPill = [
			...root.querySelectorAll<HTMLInputElement>(
				'[data-setup-field="rearSuspension.dBlockPill"]',
			),
		].find((control) => control.value === 'down/out');
		rearPill?.click();
		fixture.detectChanges();
		expect(root.textContent).toContain('D block selected: down/out');

		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.saveCurrentSetup).toHaveBeenCalledOnce();
		expect(store.saveCurrentSetup).toHaveBeenCalledWith(
			expect.objectContaining({
				carId: 'car-1',
				sourceSetupId: 'setup-1',
				sourceUpdatedAt: '2026-08-09T21:00:00.000Z',
				draft: expect.objectContaining({
					name: 'Clay baseline · Aug 9, 2:14 PM',
					sections: expect.objectContaining({
						vehicle: expect.objectContaining({ rideHeight: '14 mm' }),
						rearSuspension: expect.objectContaining({
							dBlockPill: 'down/out',
						}),
					}),
				}),
			}),
		);

		store.outcome.set({
			status: 'pending',
			operation: 'save-current-setup',
			operationId: 1,
		});
		detect();
		expect(completed).not.toHaveBeenCalled();
		store.pending.set(true);
		detect()
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.saveCurrentSetup).toHaveBeenCalledOnce();
		expect(
			detect().querySelector<HTMLButtonElement>('button[type="submit"]')
				?.textContent,
		).toContain('Saving setup');

		store.pending.set(false);
		store.outcome.set({
			status: 'succeeded',
			operation: 'save-current-setup',
			operationId: 1,
			setup: { ...setup, id: 'setup-2' },
			retainedLocally: false,
		});
		detect();
		expect(completed).toHaveBeenCalledOnce();
	});

	it('leaves the stale-write precondition empty for a legacy snapshot', () => {
		fixture.componentRef.setInput('setup', { ...setup, updatedAt: undefined });
		const root = detect();
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		expect(store.saveCurrentSetup).toHaveBeenCalledWith(
			expect.objectContaining({ sourceUpdatedAt: '' }),
		);
	});

	it('validates and focuses the name, renders store failures, and guards cancel', async () => {
		const cancelled = vi.fn();
		fixture.componentInstance.cancelled.subscribe(cancelled);
		fixture.componentRef.setInput('initialFocus', 'missing.field');
		let root = detect();
		await fixture.whenStable();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'name',
		);

		change('name', '   ');
		root = detect();
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'Name this setup',
		);
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'name',
		);
		expect(store.saveCurrentSetup).not.toHaveBeenCalled();

		change('name', 'Recovered setup');
		change('context.track', 'x'.repeat(161));
		root = detect();
		root
			.querySelector('form')
			?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
		fixture.detectChanges();
		expect(document.activeElement?.getAttribute('data-setup-field')).toBe(
			'context.track',
		);
		expect(input('context.track').getAttribute('aria-describedby')).toBe(
			'setup-change-error',
		);
		change('context.track', 'Club track');
		store.saveError.set('The server rejected this setup.');
		root = detect();
		expect(root.querySelector('[role="alert"]')?.textContent).toContain(
			'The server rejected this setup',
		);

		store.pending.set(true);
		root = detect();
		(fixture.componentInstance as unknown as { cancel(): void }).cancel();
		expect(cancelled).not.toHaveBeenCalled();
		store.pending.set(false);
		root = detect();
		root.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
		expect(cancelled).toHaveBeenCalledOnce();
	});
});
