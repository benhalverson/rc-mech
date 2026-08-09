import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupEditor } from './setup-editor';
import { emptySetupForm, type SetupFormModel } from './setup-form';
import type {
	SetupGatewayFailure,
	SetupSnapshot,
	SoDialedImportPreview,
} from './setup-snapshot';
import {
	SetupSnapshotStore,
	type SetupWorkflowCommand,
	type SetupWorkflowOutcome,
	type SetupWorkflowResult,
} from './setup-snapshot-store';

const sections = () => ({
	vehicle: {},
	drivetrain: {},
	electronics: {},
	tires: {},
	shocks: {},
	frontSuspension: {},
	rearSuspension: {},
	notes: {},
});

const setup: SetupSnapshot = {
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay baseline',
	context: { track: 'Home track', recordedAt: '2026-08-01' },
	sections: sections(),
};

const preview: SoDialedImportPreview = {
	draftId: 'draft-1',
	source: { url: null, title: null },
	carIdentity: { make: 'Associated', model: 'B7' },
	context: {},
	sections: sections(),
	uncertainValues: {},
	unmappedValues: {},
	rawValues: {},
};

class FakeSetupStore {
	private operationId = 0;
	readonly action = signal<'preview' | 'save' | 'copy' | 'current' | null>(
		null,
	);
	readonly outcome = signal<SetupWorkflowOutcome>({
		status: 'idle',
		operationId: null,
	});
	readonly mutate = vi.fn((command: SetupWorkflowCommand) => {
		this.action.set(
			command.kind === 'select-current'
				? 'current'
				: command.kind === 'cancel-import'
					? null
					: command.kind,
		);
		this.outcome.set({
			status: 'pending',
			operationId: ++this.operationId,
			command,
		});
	});

	succeed(result: SetupWorkflowResult): void {
		const pending = this.outcome();
		if (pending.status !== 'pending')
			throw new Error('Expected pending command.');
		this.action.set(null);
		this.outcome.set({ ...pending, status: 'succeeded', result });
	}

	fail(error: SetupGatewayFailure): void {
		const pending = this.outcome();
		if (pending.status !== 'pending')
			throw new Error('Expected pending command.');
		this.action.set(null);
		this.outcome.set({ ...pending, status: 'failed', error });
	}
}

type EditorHarness = {
	formModel: (() => SetupFormModel) & { set(value: SetupFormModel): void };
	formError: (() => string) & { set(value: string): void };
	importTarget: (() => { carId: string }) & {
		set(value: { carId: string }): void;
	};
	save(event?: Event): void;
	cancel(): void;
};

describe('SetupEditor', () => {
	let fixture: ComponentFixture<SetupEditor>;
	let store: FakeSetupStore;

	beforeEach(async () => {
		store = new FakeSetupStore();
		await TestBed.configureTestingModule({
			imports: [SetupEditor],
			providers: [{ provide: SetupSnapshotStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(SetupEditor);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
	});

	const harness = (): EditorHarness =>
		fixture.componentInstance as unknown as EditorHarness;

	it('owns validation, ARIA error relationships, and invalid-field focus', () => {
		const form = fixture.nativeElement.querySelector('form') as HTMLFormElement;
		form.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
		const name = form.querySelector('input') as HTMLInputElement;
		expect(document.activeElement).toBe(name);
		expect(form.getAttribute('aria-describedby')).toBe('setup-form-validation');
		expect(name.getAttribute('aria-describedby')).toBe('setup-form-validation');
		expect(form.textContent).toContain('Name this setup before saving');

		harness().formModel.set({ ...emptySetupForm(), name: 'Valid setup' });
		fixture.detectChanges();
		expect(form.getAttribute('aria-describedby')).toBeNull();

		harness().formModel.set({
			...emptySetupForm(),
			name: 'Valid setup',
			track: 'x'.repeat(161),
		});
		harness().save();
		fixture.detectChanges();
		const track = [...form.querySelectorAll('label')]
			.find((label) => label.textContent?.trim().startsWith('Track'))
			?.querySelector('input');
		expect(document.activeElement).toBe(track);
	});

	it('validates blank names, URL protocols and syntax, and PDF pages', () => {
		for (const values of [
			{ name: '   ' },
			{ name: 'Valid', sourceUrl: 'ftp://example.test/setup' },
			{ name: 'Valid', sourceUrl: 'not a URL' },
			{ name: 'Valid', pdfPage: '0' },
		]) {
			harness().formModel.set({ ...emptySetupForm(), ...values });
			harness().save();
			expect(harness().formError()).toContain('Review the highlighted');
		}
		harness().formModel.set({
			...emptySetupForm(),
			name: 'Valid',
			sourceUrl: 'https://example.test/setup',
			pdfPage: '2',
		});
		fixture.detectChanges();
		expect(harness().formError()).toBe('');
	});

	it('dispatches a manual save and renders its own operation outcome', () => {
		harness().formModel.set({ ...emptySetupForm(), name: 'New baseline' });
		harness().save();
		expect(store.mutate).toHaveBeenCalledWith(
			expect.objectContaining({
				kind: 'save',
				sourceCarId: 'car-1',
				targetCarId: 'car-1',
				mode: 'add',
				setupId: null,
				importDraft: null,
			}),
		);
		const result = { kind: 'save', setup, targetCarId: 'car-1' } as const;
		store.succeed(result);
		fixture.detectChanges();
		expect(harness().formError()).toBe('');
	});

	it('initializes and updates an existing snapshot', () => {
		fixture.componentRef.setInput('mode', 'edit');
		fixture.componentRef.setInput('setup', setup);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Repair a recording mistake',
		);
		expect(harness().formModel()).toMatchObject({
			name: 'Clay baseline',
			track: 'Home track',
		});
		harness().save();
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				mode: 'edit',
				setupId: 'setup-1',
			}),
		);
	});

	it('owns imported target selection, review save, and create-car intent', () => {
		fixture.componentRef.setInput('importPreview', preview);
		fixture.componentRef.setInput(
			'importSourceUrl',
			'https://sodialed.com/setup/abc',
		);
		fixture.componentRef.setInput('availableCars', [
			{ id: 'car-1', name: 'Red' },
			{ id: 'car-2', name: 'Blue' },
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Import review draft');
		expect(harness().formModel().sourceUrl).toBe(
			'https://sodialed.com/setup/abc',
		);

		const identities: unknown[] = [];
		fixture.componentInstance.createCarFromImport.subscribe((identity) =>
			identities.push(identity),
		);
		(
			fixture.nativeElement.querySelector(
				'app-setup-import-review button',
			) as HTMLButtonElement
		).click();
		expect(identities).toEqual([
			{ name: 'Associated B7', make: 'Associated', model: 'B7' },
		]);

		harness().importTarget.set({ carId: 'car-2' });
		const select = fixture.nativeElement.querySelector(
			'app-setup-import-review select',
		) as HTMLSelectElement;
		select.value = 'car-2';
		select.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		expect(harness().importTarget()).toEqual({ carId: 'car-2' });
		harness().save();
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({
				targetCarId: 'car-2',
				setupId: null,
				importDraft: expect.objectContaining({ draftId: 'draft-1' }),
			}),
		);

		Reflect.set(fixture.componentInstance, 'importTarget', { carId: 'car-1' });
		fixture.detectChanges();
		select.value = 'car-2';
		select.dispatchEvent(new Event('input'));
		fixture.detectChanges();
		expect(Reflect.get(fixture.componentInstance, 'importTarget')).toEqual({
			carId: 'car-2',
		});
	});

	it('cancels manual and imported sessions while respecting pending actions', () => {
		const cancelled = vi.fn();
		fixture.componentInstance.cancelled.subscribe(cancelled);
		(
			fixture.nativeElement.querySelector(
				'.form-actions button[type="button"]',
			) as HTMLButtonElement
		).click();
		expect(cancelled).toHaveBeenCalledOnce();
		expect(store.mutate).not.toHaveBeenCalled();

		fixture.componentRef.setInput('importPreview', preview);
		fixture.detectChanges();
		harness().cancel();
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'cancel-import',
			draftId: 'draft-1',
		});
		expect(cancelled).toHaveBeenCalledTimes(2);

		store.action.set('save');
		harness().cancel();
		expect(cancelled).toHaveBeenCalledTimes(2);
	});

	it('maps save failures and guards busy or missing routes', () => {
		for (const [failure, message] of [
			[{ kind: 'http', status: 401 }, 'session has expired'],
			[{ kind: 'unavailable' }, 'could not be saved'],
		] as const) {
			harness().formModel.set({ ...emptySetupForm(), name: 'Baseline' });
			harness().save();
			store.fail(failure);
			fixture.detectChanges();
			expect(harness().formError()).toContain(message);
		}

		store.action.set('save');
		harness().save();
		fixture.componentRef.setInput('carId', '');
		store.action.set(null);
		fixture.detectChanges();
		harness().formModel.set({ ...emptySetupForm(), name: 'No car' });
		harness().save(new Event('submit'));
		expect(store.mutate).toHaveBeenCalledTimes(2);

		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('importPreview', preview);
		fixture.detectChanges();
		harness().importTarget.set({ carId: '' });
		harness().save();
		expect(store.mutate).toHaveBeenLastCalledWith(
			expect.objectContaining({ targetCarId: 'car-1' }),
		);
		store.succeed({ kind: 'preview', preview });
		fixture.detectChanges();
		store.mutate.mockImplementationOnce(() => undefined);
		harness().save();
	});

	it('renders server errors without a validation summary when the form is valid', () => {
		harness().formModel.set({ ...emptySetupForm(), name: 'Valid setup' });
		harness().formError.set('The server rejected this setup.');
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'The server rejected this setup.',
		);
		expect(
			fixture.nativeElement.querySelector('#setup-form-validation ul'),
		).toBeNull();
	});
});
