import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsumableEntry, MaintenanceCar } from '../maintenance.models';
import {
	ConsumableEntryEditor,
	type ConsumableEntryEditorRequest,
	type ConsumableEntryForm,
} from './consumable-entry-editor';
import {
	type ConsumableOutcome,
	ConsumableStore,
	type TireLookupOutcome,
} from './consumable-store';

const car: MaintenanceCar = { id: 'car-1', name: 'Buggy', archivedAt: null };
const fluid: ConsumableEntry = {
	id: 'entry-1',
	carId: 'car-1',
	kind: 'shock-fluid',
	performedAt: '2026-08-09T12:30:00.000Z',
	fluidArea: 'custom',
	customArea: 'Center differential',
	cost: 12.5,
	notes: 'Measured carefully',
};

const store = {
	cars: signal<MaintenanceCar[]>([car]),
	timezone: signal('UTC'),
	action: signal<string | null>(null),
	outcome: signal<ConsumableOutcome>({ status: 'idle', operationId: null }),
	tireLookup: signal<TireLookupOutcome>({ status: 'idle', carId: null }),
	loadTires: vi.fn(),
	mutate: vi.fn(),
};

type EditorHarness = {
	form: ReturnType<typeof signal<ConsumableEntryForm>>;
	entryFields: () => {
		invalid(): boolean;
		errorSummary(): Array<{ message?: string }>;
	};
	formError: ReturnType<typeof signal<string>>;
	changeKind(event: Event): void;
	save(event: Event): void;
	cancel(): void;
};

describe('ConsumableEntryEditor', () => {
	let fixture: ComponentFixture<ConsumableEntryEditor>;
	let app: EditorHarness;
	let cancelled: number;
	let saved: number;

	beforeEach(async () => {
		vi.clearAllMocks();
		store.cars.set([car]);
		store.timezone.set('UTC');
		store.action.set(null);
		store.outcome.set({ status: 'idle', operationId: null });
		store.tireLookup.set({ status: 'idle', carId: null });
		await TestBed.configureTestingModule({
			imports: [ConsumableEntryEditor],
			providers: [{ provide: ConsumableStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(ConsumableEntryEditor);
		cancelled = 0;
		saved = 0;
		fixture.componentInstance.cancelled.subscribe(() => cancelled++);
		fixture.componentInstance.saved.subscribe(() => saved++);
		fixture.detectChanges();
		app = fixture.componentInstance as unknown as EditorHarness;
	});

	const request = (value: ConsumableEntryEditorRequest | null): void => {
		fixture.componentRef.setInput('request', value);
		fixture.detectChanges();
	};

	const control = (label: string): HTMLElement => {
		const match = [...fixture.nativeElement.querySelectorAll('label')].find(
			(candidate: HTMLLabelElement) =>
				candidate.querySelector('span')?.textContent?.trim() === label,
		) as HTMLLabelElement | undefined;
		expect(match).toBeTruthy();
		return match?.querySelector('input, select, textarea') as HTMLElement;
	};

	it('opens creation, focuses the editor, and dispatches one tire snapshot', async () => {
		expect(fixture.nativeElement.querySelector('form')).toBeNull();
		store.cars.set([car, { id: 'archived', name: 'Old', archivedAt: 'x' }]);
		request({ kind: 'create' });
		await fixture.whenStable();
		expect(document.activeElement).toBe(
			fixture.nativeElement.querySelector('#consumable-form-title'),
		);
		expect(
			[...fixture.nativeElement.querySelectorAll('option')].some(
				(option: HTMLOptionElement) => option.value === 'archived',
			),
		).toBe(false);

		app.form.set({
			carId: 'car-1',
			kind: 'tires',
			performedAt: '2026-08-09T12:30',
			fluidArea: 'front-shocks',
			customArea: '',
			axle: 'both',
			frontDetails: ' Front snapshot ',
			rearDetails: ' Rear snapshot ',
			frontCost: '30.5',
			rearCost: '0',
			notes: ' Track day ',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenCalledOnce();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'save',
			mode: 'create',
			carId: 'car-1',
			id: null,
			maintenance: {
				kind: 'tires',
				performedAt: '2026-08-09T12:30:00.000Z',
				axle: 'both',
				frontDetails: 'Front snapshot',
				frontCost: 30.5,
				rearDetails: 'Rear snapshot',
				rearCost: 0,
				notes: 'Track day',
			},
		});
	});

	it('prefills tires from the current setup and cleans fields when kind changes', () => {
		request({ kind: 'create' });
		const kind = document.createElement('select');
		kind.add(new Option('Tires', 'tires'));
		kind.value = 'tires';
		app.changeKind({ target: kind } as unknown as Event);
		expect(store.loadTires).toHaveBeenCalledWith('car-1');

		store.tireLookup.set({
			status: 'succeeded',
			carId: 'car-1',
			tires: { front: 'Schumacher', insert: 28 },
		});
		fixture.detectChanges();
		expect(app.form().frontDetails).toContain('front: Schumacher');
		expect(app.form().rearDetails).toContain('insert: 28');

		app.form.update((current) => ({
			...current,
			frontDetails: 'Keep front',
			rearDetails: 'Keep rear',
		}));
		store.tireLookup.set({
			status: 'succeeded',
			carId: 'other',
			tires: { front: 'Stale' },
		});
		fixture.detectChanges();
		store.tireLookup.set({
			status: 'succeeded',
			carId: 'car-1',
			tires: null,
		});
		fixture.detectChanges();
		expect(app.form().frontDetails).toBe('Keep front');

		kind.add(new Option('Fluid', 'shock-fluid'));
		kind.value = 'shock-fluid';
		app.form.update((current) => ({
			...current,
			axle: 'both',
			rearCost: '20',
		}));
		app.changeKind({ target: kind } as unknown as Event);
		expect(app.form()).toMatchObject({
			kind: 'shock-fluid',
			axle: 'front',
			rearDetails: '',
			rearCost: '',
		});
		app.changeKind(new Event('change'));
	});

	it('opens fluid and tire edits with compatibility defaults and saves fluid', () => {
		request({ kind: 'edit', entry: fluid });
		expect(fixture.nativeElement.textContent).toContain('Edit history');
		expect(app.form()).toMatchObject({
			carId: 'car-1',
			kind: 'shock-fluid',
			fluidArea: 'custom',
			customArea: 'Center differential',
			frontCost: '12.5',
			notes: 'Measured carefully',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'save',
			mode: 'edit',
			carId: 'car-1',
			id: 'entry-1',
			maintenance: {
				kind: 'shock-fluid',
				performedAt: '2026-08-09T12:30:00.000Z',
				fluidArea: 'custom',
				customArea: 'Center differential',
				cost: 12.5,
				notes: 'Measured carefully',
			},
		});

		request({
			kind: 'edit',
			entry: {
				...fluid,
				kind: 'differential-fluid',
				fluidArea: null,
				customArea: null,
				cost: null,
				notes: null,
			},
		});
		expect(app.form()).toMatchObject({
			fluidArea: 'front-shocks',
			customArea: '',
			frontCost: '',
			notes: '',
		});

		request({
			kind: 'edit',
			entry: {
				...fluid,
				kind: 'tires',
				axle: null,
				frontDetails: null,
				rearDetails: null,
				frontCost: 24,
				rearCost: null,
			},
		});
		expect(app.form()).toMatchObject({
			axle: 'front',
			frontDetails: '',
			rearDetails: '',
			frontCost: '24',
			rearCost: '',
		});
		request({
			kind: 'edit',
			entry: {
				...fluid,
				kind: 'tires',
				axle: 'rear',
				frontCost: null,
				rearCost: 18,
			},
		});
		expect(app.form()).toMatchObject({ frontCost: '', rearCost: '18' });
	});

	it('omits empty and axle-inapplicable optional payload fields', () => {
		request({ kind: 'create' });
		app.form.set({
			...app.form(),
			kind: 'tires',
			performedAt: '2026-08-09T12:30',
			axle: 'front',
			frontDetails: '',
			frontCost: '10',
			rearDetails: 'Ignore rear',
			rearCost: '20',
			notes: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				maintenance: {
					kind: 'tires',
					performedAt: '2026-08-09T12:30:00.000Z',
					axle: 'front',
					frontCost: 10,
				},
			}),
		);

		app.form.set({
			...app.form(),
			axle: 'rear',
			frontDetails: 'Ignore front',
			frontCost: '10',
			rearDetails: 'Rear only',
			rearCost: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				maintenance: expect.objectContaining({
					axle: 'rear',
					rearDetails: 'Rear only',
				}),
			}),
		);

		app.form.set({
			...app.form(),
			kind: 'differential-fluid',
			fluidArea: 'rear-differential',
			customArea: 'Ignore custom',
			frontCost: '',
			rearCost: '',
			notes: '',
		});
		app.save(new Event('submit'));
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				maintenance: {
					kind: 'differential-fluid',
					performedAt: '2026-08-09T12:30:00.000Z',
					fluidArea: 'rear-differential',
				},
			}),
		);
	});

	it('focuses every invalid entry field and uses defensive validation', () => {
		request({ kind: 'create' });
		const submit = (): void => {
			fixture.detectChanges();
			app.save(new Event('submit'));
			fixture.detectChanges();
		};

		app.form.set({ ...app.form(), carId: '' });
		submit();
		expect(document.activeElement).toBe(control('Car'));
		app.form.set({ ...app.form(), carId: 'car-1', performedAt: '' });
		submit();
		expect(document.activeElement).toBe(control('Change date'));
		app.form.set({
			...app.form(),
			performedAt: '2026-08-09T12:30',
			kind: 'tires',
			frontDetails: '',
			frontCost: '',
		});
		submit();
		expect(document.activeElement).toBe(control('Front tire details'));
		app.form.set({
			...app.form(),
			axle: 'rear',
			rearDetails: '',
			rearCost: '',
		});
		submit();
		expect(document.activeElement).toBe(control('Rear tire details'));
		app.form.set({
			...app.form(),
			axle: 'front',
			frontDetails: 'Front',
			frontCost: '-1',
		});
		submit();
		expect(document.activeElement).toBe(control('Front cost (USD)'));
		app.form.set({
			...app.form(),
			axle: 'rear',
			frontCost: '',
			rearDetails: 'Rear',
			rearCost: '-1',
		});
		submit();
		expect(document.activeElement).toBe(control('Rear cost (USD)'));
		app.form.set({
			...app.form(),
			kind: 'shock-fluid',
			frontCost: '',
			rearCost: '',
			notes: 'x'.repeat(4001),
		});
		submit();
		expect(document.activeElement).toBe(control('Notes'));

		Object.defineProperty(app.entryFields(), 'errorSummary', {
			value: () => [],
		});
		app.form.set({ ...app.form(), carId: '' });
		submit();
		expect(app.formError()).toBe('Review the consumable history fields.');
		Object.defineProperty(app.entryFields(), 'invalid', { value: () => false });
		app.form.set({
			...app.form(),
			carId: 'car-1',
			kind: 'tires',
			axle: 'both',
			frontDetails: '',
			frontCost: '',
			rearDetails: '',
			rearCost: '',
			notes: '',
		});
		submit();
		expect(app.formError()).toContain('front or rear tire details');
		app.form.set({
			...app.form(),
			axle: 'rear',
			frontDetails: 'Ignored',
			frontCost: '',
			rearDetails: '',
			rearCost: '',
		});
		submit();
		expect(app.formError()).toContain('front or rear tire details');
		app.form.set({
			...app.form(),
			kind: 'shock-fluid',
			frontCost: 'not-a-number',
		});
		submit();
		expect(app.formError()).toContain('zero or greater');
	});

	it('guards pending and unavailable requests and rejects read-only edits', () => {
		request({ kind: 'create' });
		app.form.set({
			...app.form(),
			performedAt: '2026-08-09T12:30',
			frontCost: '',
			notes: '',
		});
		store.action.set('create');
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();
		store.action.set(null);
		request(null);
		app.save(new Event('submit'));
		expect(store.mutate).not.toHaveBeenCalled();

		store.cars.set([]);
		request({ kind: 'create' });
		store.cars.set([{ ...car, archivedAt: 'x' }]);
		request({ kind: 'edit', entry: fluid });
		store.cars.set([car]);
		request({ kind: 'edit', entry: { ...fluid, deletedAt: 'x' } });
		expect(cancelled).toBe(3);
	});

	it('maps save outcomes once, closes after success, and restores focus', async () => {
		const title = document.createElement('h3');
		title.id = 'consumable-title';
		title.tabIndex = -1;
		document.body.append(title);
		request({ kind: 'create' });
		const command = {
			kind: 'save' as const,
			mode: 'create' as const,
			carId: 'car-1',
			id: null,
			maintenance: {
				kind: 'shock-fluid' as const,
				performedAt: fluid.performedAt,
				fluidArea: 'front-shocks' as const,
			},
		};
		store.outcome.set({
			status: 'failed',
			operationId: 1,
			command,
			failure: 'car-archived',
		});
		fixture.detectChanges();
		expect(app.formError()).toContain('car is archived');
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command,
			failure: 'save-failed',
		});
		fixture.detectChanges();
		expect(app.formError()).toContain('could not be saved');
		store.outcome.set({
			status: 'failed',
			operationId: 2,
			command,
			failure: 'save-failed',
		});
		fixture.detectChanges();
		store.outcome.set({
			status: 'failed',
			operationId: 3,
			command: { kind: 'change', action: 'archive', entry: fluid },
			failure: 'archive-failed',
		});
		fixture.detectChanges();
		store.outcome.set({ status: 'pending', operationId: 4, command });
		fixture.detectChanges();
		store.outcome.set({ status: 'succeeded', operationId: 4, command });
		fixture.detectChanges();
		await fixture.whenStable();
		expect(saved).toBe(1);
		expect(document.activeElement).toBe(title);
		title.remove();
	});

	it('executes cancellation and renders every form variant and action label', async () => {
		const launcher = document.createElement('button');
		launcher.dataset['consumableLauncher'] = 'record';
		document.body.append(launcher);
		request({ kind: 'create' });
		for (const [kind, text] of [
			['shock-fluid', 'front shocks'],
			['differential-fluid', 'front differential'],
		] as const) {
			app.form.set({ ...app.form(), kind });
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain(text);
		}
		app.form.set({
			...app.form(),
			kind: 'shock-fluid',
			fluidArea: 'custom',
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Custom service area');
		for (const axle of ['front', 'rear', 'both'] as const) {
			app.form.set({ ...app.form(), kind: 'tires', axle });
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain('Axle sets');
		}
		for (const action of ['create', 'edit'] as const) {
			store.action.set(action);
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain('Saving…');
		}
		store.action.set('refresh');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Save change');
		store.action.set(null);
		fixture.detectChanges();
		const kind = control('What changed') as HTMLSelectElement;
		kind.value = 'shock-fluid';
		kind.dispatchEvent(new Event('change'));
		(
			fixture.nativeElement.querySelector('form') as HTMLFormElement
		).dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const cancel = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Cancel',
		) as HTMLButtonElement;
		cancel.click();
		await fixture.whenStable();
		expect(cancelled).toBe(1);
		expect(document.activeElement).toBe(launcher);
		launcher.remove();
	});
});
