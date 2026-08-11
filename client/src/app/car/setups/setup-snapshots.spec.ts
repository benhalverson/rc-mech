import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupEditor } from './setup-editor';
import type {
	SetupGatewayFailure,
	SetupSectionValues,
	SetupSnapshot,
	SoDialedImportPreview,
} from './setup-snapshot';
import {
	SetupSnapshotStore,
	type SetupWorkflowCommand,
	type SetupWorkflowOutcome,
	type SetupWorkflowResult,
} from './setup-snapshot-store';
import { SetupSnapshots } from './setup-snapshots';
import type { SetupSyncMark } from './setup-sync.models';

const sections = (vehicle: SetupSectionValues = {}) => ({
	vehicle,
	drivetrain: {},
	electronics: {},
	tires: {},
	shocks: {},
	frontSuspension: {},
	rearSuspension: {},
	notes: {},
});

const currentSetup: SetupSnapshot = {
	id: 'setup-1',
	carId: 'car-1',
	name: 'Clay baseline',
	current: true,
	context: {
		track: 'Home track',
		condition: 'Dry',
		recordedAt: '2026-08-01',
	},
	sections: sections({ rideHeight: '22mm' }),
	source: {
		url: 'https://example.test/setup',
		pdfUrl: 'https://example.test/setup.pdf',
		pdfTitle: 'Sheet 1',
		pdfPage: 1,
	},
	unmappedValues: { casterDiagram: 'review' },
};

const preview: SoDialedImportPreview = {
	draftId: 'draft-1',
	source: {},
	carIdentity: { make: 'Associated', model: 'B7' },
	context: {},
	sections: sections(),
	uncertainValues: {},
	unmappedValues: {},
	rawValues: {},
};

class FakeSetupStore {
	private operationId = 0;
	readonly setups = signal<SetupSnapshot[]>([]);
	readonly loading = signal(false);
	readonly failure = signal<{ message: string; retryable: boolean } | null>(
		null,
	);
	readonly action = signal<'preview' | 'save' | 'copy' | 'current' | null>(
		null,
	);
	readonly syncMark = signal<SetupSyncMark>({ kind: 'synced' });
	readonly outcome = signal<SetupWorkflowOutcome>({
		status: 'idle',
		operationId: null,
	});
	readonly selectCar = vi.fn();
	readonly retry = vi.fn();
	readonly clearOutcome = vi.fn(() => {
		this.action.set(null);
		this.outcome.set({ status: 'idle', operationId: null });
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

type SnapshotsHarness = {
	selectedId: (() => string | null) & { set(value: string | null): void };
	editor: (() => unknown) & { set(value: unknown): void };
	actionError: (() => string) & { set(value: string): void };
	actionMessage: (() => string) & { set(value: string): void };
	selected(): SetupSnapshot | null;
	copySource(): SetupSnapshot | null;
	openAdd(): void;
	openEdit(): void;
	closeEditor(): void;
	copyPrevious(): void;
	copy(): void;
	makeCurrent(): void;
	select(setup: SetupSnapshot): void;
	requestCreateCar(identity: {
		name: string;
		make: string;
		model: string;
	}): void;
	sectionHasValues(section: SetupSectionValues): boolean;
};

describe('SetupSnapshots', () => {
	let fixture: ComponentFixture<SetupSnapshots>;
	let store: FakeSetupStore;

	beforeEach(async () => {
		store = new FakeSetupStore();
		await TestBed.configureTestingModule({
			imports: [SetupSnapshots],
			providers: [{ provide: SetupSnapshotStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(SetupSnapshots);
	});

	const harness = (): SnapshotsHarness =>
		fixture.componentInstance as unknown as SnapshotsHarness;

	const open = (setups: SetupSnapshot[] = []): void => {
		store.setups.set(setups);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
	};

	it('waits for a car, selects it, and renders loading and retryable failures', () => {
		fixture.detectChanges();
		expect(store.selectCar).not.toHaveBeenCalled();
		store.loading.set(true);
		open();
		expect(store.selectCar).toHaveBeenCalledWith('car-1');
		expect(fixture.nativeElement.textContent).toContain(
			'Reading setup history',
		);

		store.loading.set(false);
		store.failure.set({ message: 'Setup history failed.', retryable: true });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Setup history failed.',
		);
		(
			fixture.nativeElement.querySelector(
				'[role="alert"] button',
			) as HTMLButtonElement
		).click();
		expect(store.retry).toHaveBeenCalledOnce();

		store.failure.set({ message: 'Session expired.', retryable: false });
		fixture.detectChanges();
		expect(
			fixture.nativeElement.querySelector('[role="alert"] button'),
		).toBeNull();
	});

	it('coordinates add, edit, child cancellation, and store save outcomes', () => {
		open([currentSetup]);
		(
			fixture.nativeElement.querySelector(
				'.section-heading button',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Put a baseline on the bench',
		);
		fixture.debugElement
			.query(By.directive(SetupEditor))
			.triggerEventHandler('cancelled');
		expect(harness().editor()).toBeNull();

		harness().openEdit();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Repair a recording mistake',
		);
		const imported = { ...currentSetup, id: 'setup-imported', carId: 'car-2' };
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-2',
			mode: 'add',
			setupId: null,
			snapshot: { name: 'Imported' },
			importDraft: null,
		});
		store.succeed({ kind: 'save', setup: imported, targetCarId: 'car-2' });
		fixture.detectChanges();
		expect(harness().actionMessage()).toContain('selected car');

		harness().openAdd();
		fixture.detectChanges();
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'add',
			setupId: null,
			snapshot: { name: 'Local' },
			importDraft: null,
		});
		store.setups.set([{ ...currentSetup, id: 'setup-2' }, currentSetup]);
		store.succeed({
			kind: 'save',
			setup: { ...currentSetup, id: 'setup-2' },
			targetCarId: 'car-1',
		});
		fixture.detectChanges();
		expect(harness().selectedId()).toBe('setup-2');
	});

	it('coordinates import preview and the explicit create-car intent', () => {
		open();
		store.mutate({
			kind: 'preview',
			carId: 'car-1',
			url: 'https://sodialed.com/setup/abc',
		});
		store.succeed({ kind: 'preview', preview });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Import review draft');

		const emitted: unknown[] = [];
		fixture.componentInstance.createCarFromImport.subscribe((identity) =>
			emitted.push(identity),
		);
		fixture.debugElement
			.query(By.directive(SetupEditor))
			.triggerEventHandler('createCarFromImport', {
				name: 'Imported car',
				make: '',
				model: '',
			});
		expect(emitted).toEqual([{ name: 'Imported car', make: '', model: '' }]);

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		harness().closeEditor();
		store.mutate({
			kind: 'preview',
			carId: 'car-1',
			url: 'https://sodialed.com/setup/other',
		});
		store.succeed({ kind: 'preview', preview });
		fixture.detectChanges();
		harness().openAdd();
		expect(harness().editor()).toBeNull();
	});

	it('defaults selection to current history and dispatches copy actions', () => {
		const historical = {
			...currentSetup,
			id: 'setup-old',
			name: 'Historical',
			current: false,
		};
		open([historical, currentSetup]);
		expect(harness().selectedId()).toBe('setup-1');
		harness().select(historical);
		expect(harness().selected()?.id).toBe('setup-old');
		expect(harness().copySource()?.id).toBe('setup-1');
		harness().copyPrevious();
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'copy',
			carId: 'car-1',
			setupId: 'setup-1',
		});
		const copied = { ...historical, id: 'setup-copy', name: 'Copied setup' };
		store.setups.set([copied, historical, currentSetup]);
		store.succeed({ kind: 'copy', setup: copied });
		fixture.detectChanges();
		expect(harness().selectedId()).toBe('setup-copy');
		expect(fixture.nativeElement.textContent).toContain(
			'Repair a recording mistake',
		);

		harness().closeEditor();
		harness().select(historical);
		harness().copy();
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'copy',
			carId: 'car-1',
			setupId: 'setup-old',
		});
	});

	it('dispatches current selection and maps copy/current failures', () => {
		const historical = { ...currentSetup, id: 'setup-old', current: false };
		open([historical]);
		harness().makeCurrent();
		expect(store.mutate).toHaveBeenLastCalledWith({
			kind: 'select-current',
			carId: 'car-1',
			setupId: 'setup-old',
		});
		store.succeed({
			kind: 'select-current',
			setup: { ...historical, current: true },
		});
		fixture.detectChanges();
		expect(harness().editor()).toBeNull();

		for (const [command, failure, message] of [
			[
				{ kind: 'copy', carId: 'car-1', setupId: 'setup-old' },
				{ kind: 'http', status: 401 },
				'session has expired',
			],
			[
				{ kind: 'copy', carId: 'car-1', setupId: 'setup-old' },
				{ kind: 'unavailable' },
				'could not be copied',
			],
			[
				{
					kind: 'select-current',
					carId: 'car-1',
					setupId: 'setup-old',
				},
				{ kind: 'unavailable' },
				'could not be changed',
			],
		] as const) {
			store.mutate(command);
			store.fail(failure);
			fixture.detectChanges();
			expect(harness().actionError()).toContain(message);
		}
	});

	it('reports durable saves and every setup synchronization state', () => {
		const historical = { ...currentSetup, id: 'setup-old', current: false };
		open([historical]);
		store.mutate({
			kind: 'select-current',
			carId: 'car-1',
			setupId: historical.id,
		});
		store.succeed({
			kind: 'select-current',
			setup: { ...historical, current: true },
			retainedLocally: true,
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Current setup saved on this device',
		);
		store.mutate({
			kind: 'save',
			sourceCarId: 'car-1',
			targetCarId: 'car-1',
			mode: 'add',
			setupId: null,
			snapshot: { name: 'Local setup' },
			importDraft: null,
		});
		store.succeed({
			kind: 'save',
			setup: currentSetup,
			targetCarId: 'car-1',
			retainedLocally: true,
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Setup saved on this device',
		);
		store.mutate({
			kind: 'copy',
			carId: 'car-1',
			setupId: historical.id,
		});
		store.succeed({
			kind: 'copy',
			setup: historical,
			retainedLocally: true,
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Setup copy saved on this device',
		);

		for (const [mark, text] of [
			[{ kind: 'pending', operationIds: ['operation-1'] }, 'Pending sync'],
			[
				{ kind: 'syncing', operationIds: ['operation-1'] },
				'Syncing setup history',
			],
			[
				{
					kind: 'needs-attention',
					operationId: 'operation-1',
					feedback: { code: 'invalid', message: 'Review the setup.' },
				},
				'Needs attention',
			],
			[
				{
					kind: 'conflict',
					operationId: 'operation-1',
					remote: {
						currentSetupId: 'remote',
						currentSetupVersion: 2,
						setup: null,
					},
				},
				'Setup conflict',
			],
		] as const) {
			store.syncMark.set(mark);
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain(text);
		}
	});

	it('guards unavailable mutations and resets coordinator state on route reuse', () => {
		open();
		harness().copy();
		harness().copyPrevious();
		harness().openEdit();
		harness().makeCurrent();
		expect(store.mutate).not.toHaveBeenCalled();

		store.setups.set([currentSetup]);
		fixture.detectChanges();
		harness().copy();
		harness().makeCurrent();
		expect(store.mutate).toHaveBeenCalledOnce();
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		store.action.set(null);
		harness().copy();
		harness().openEdit();
		expect(store.mutate).toHaveBeenCalledOnce();

		fixture.componentRef.setInput('archived', false);
		harness().openAdd();
		harness().actionError.set('Old error');
		harness().actionMessage.set('Old message');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		expect(harness().editor()).toBeNull();
		expect(harness().selectedId()).toBe('setup-1');
		expect(harness().actionError()).toBe('');
		expect(harness().actionMessage()).toBe('');
		expect(store.clearOutcome).toHaveBeenCalled();
		expect(store.selectCar).toHaveBeenLastCalledWith('car-2');
	});

	it('guards selected mutations until a route car exists and ignores child failures', () => {
		const historical = { ...currentSetup, id: 'setup-old', current: false };
		store.setups.set([historical]);
		fixture.detectChanges();
		harness().copy();
		harness().makeCurrent();
		expect(store.mutate).not.toHaveBeenCalled();

		store.outcome.set({
			status: 'failed',
			operationId: 99,
			command: {
				kind: 'preview',
				carId: 'car-1',
				url: 'https://sodialed.com/setup/abc',
			},
			error: { kind: 'unavailable' },
		});
		fixture.detectChanges();
		expect(harness().editor()).toBeNull();
	});

	it('executes setup actions through their rendered controls', () => {
		const historical = {
			...currentSetup,
			id: 'setup-old',
			name: 'Historical',
			current: false,
		};
		open([currentSetup, historical]);
		const button = (label: string): HTMLButtonElement => {
			const match = [...fixture.nativeElement.querySelectorAll('button')].find(
				(candidate: HTMLButtonElement) =>
					candidate.textContent?.trim() === label && !candidate.disabled,
			);
			expect(match).toBeTruthy();
			return match as HTMLButtonElement;
		};

		button('Copy previous').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Copying…');
		store.fail({ kind: 'unavailable' });
		fixture.detectChanges();

		const historicalRow = [
			...fixture.nativeElement.querySelectorAll('.setup-row'),
		].find((row: HTMLButtonElement) =>
			row.textContent?.includes('Historical'),
		) as HTMLButtonElement;
		historicalRow.click();
		fixture.detectChanges();
		button('Copy setup').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Copying…');
		store.fail({ kind: 'unavailable' });
		fixture.detectChanges();

		button('Correct record').click();
		fixture.detectChanges();
		button('Cancel').click();
		fixture.detectChanges();
		button('Select as current').click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Selecting…');
		store.fail({ kind: 'unavailable' });
	});

	it('renders archived, source, raw, copied, and empty display variants', () => {
		const partial: SetupSnapshot = {
			...currentSetup,
			id: 'setup-partial',
			name: 'Partial',
			current: false,
			context: null,
			sections: sections({ rideHeight: '', weight: '1500g' }),
			source: {
				url: null,
				pdfUrl: null,
				pdfTitle: 'Title only',
				pdfPage: null,
			},
			copiedFromSetupId: 'setup-source',
			rawValues: { source: 'raw' },
			unmappedValues: null,
		};
		const bare: SetupSnapshot = {
			...partial,
			id: 'setup-bare',
			name: 'Bare',
			source: null,
			copiedFromSetupId: null,
			rawValues: null,
		};
		open([currentSetup, partial, bare]);
		expect(fixture.nativeElement.textContent).toContain('Open source link');
		expect(fixture.nativeElement.textContent).toContain(
			'Unmapped / raw values',
		);
		harness().select(partial);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Track not recorded');
		expect(fixture.nativeElement.textContent).toContain('Date not recorded');
		expect(fixture.nativeElement.textContent).toContain('Title only');
		expect(fixture.nativeElement.textContent).toContain('Copied from');
		expect(fixture.nativeElement.textContent).toContain('1500g');
		harness().select(bare);
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('.provenance')).toBeNull();
		expect(fixture.nativeElement.querySelector('.unmapped')).toBeNull();
		expect(harness().sectionHasValues({ empty: null, blank: '' })).toBe(false);
		expect(harness().sectionHasValues({ weight: '1500g' })).toBe(true);

		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('This car is archived');
		expect(
			fixture.nativeElement.querySelector('app-setup-import-preview'),
		).toBeNull();
	});

	it('renders archived empty history without a create action', () => {
		fixture.componentRef.setInput('archived', true);
		open();
		expect(fixture.nativeElement.textContent).toContain(
			'No setup snapshots yet',
		);
		expect(
			fixture.nativeElement.querySelector('.empty-state button'),
		).toBeNull();
	});

	it('opens the first setup editor through the empty-state control', () => {
		open();
		(
			fixture.nativeElement.querySelector(
				'.empty-state button',
			) as HTMLButtonElement
		).click();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Put a baseline on the bench',
		);
	});
});
