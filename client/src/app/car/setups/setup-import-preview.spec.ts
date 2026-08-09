import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SetupImportPreview } from './setup-import-preview';
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

const preview: SoDialedImportPreview = {
	draftId: 'draft-1',
	source: {},
	carIdentity: {},
	context: {},
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
	uncertainValues: {},
	unmappedValues: {},
	rawValues: {},
};

class FakeSetupStore {
	private operationId = 0;
	readonly outcome = signal<SetupWorkflowOutcome>({
		status: 'idle',
		operationId: null,
	});
	readonly mutate = vi.fn((command: SetupWorkflowCommand) => {
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
		this.outcome.set({ ...pending, status: 'succeeded', result });
	}

	fail(error: SetupGatewayFailure): void {
		const pending = this.outcome();
		if (pending.status !== 'pending')
			throw new Error('Expected pending command.');
		this.outcome.set({ ...pending, status: 'failed', error });
	}
}

describe('SetupImportPreview', () => {
	let fixture: ComponentFixture<SetupImportPreview>;
	let store: FakeSetupStore;

	beforeEach(async () => {
		store = new FakeSetupStore();
		await TestBed.configureTestingModule({
			imports: [SetupImportPreview],
			providers: [{ provide: SetupSnapshotStore, useValue: store }],
		}).compileComponents();
		fixture = TestBed.createComponent(SetupImportPreview);
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.detectChanges();
	});

	const input = (): HTMLInputElement =>
		fixture.nativeElement.querySelector('#sodialed-url') as HTMLInputElement;

	const enter = (value: string): void => {
		input().value = value;
		input().dispatchEvent(new Event('input'));
		fixture.detectChanges();
	};

	const submit = (): void => {
		fixture.nativeElement
			.querySelector('form')
			.dispatchEvent(new Event('submit'));
		fixture.detectChanges();
	};

	it('validates the URL, associates its error, and restores focus', () => {
		enter('   ');
		submit();
		expect(fixture.nativeElement.textContent).toContain(
			'Paste a So Dialed setup URL.',
		);
		expect(fixture.nativeElement.textContent).not.toContain(
			'including https://',
		);
		enter('https://example.test/not-supported');
		submit();
		expect(input().getAttribute('aria-describedby')).toBe(
			'import-url-validation',
		);
		expect(document.activeElement).toBe(input());
		expect(fixture.nativeElement.textContent).toContain(
			'supported So Dialed URL',
		);
		expect(store.mutate).not.toHaveBeenCalled();
	});

	it('dispatches one preview command and leaves result coordination to the store', () => {
		enter(' https://sodialed.com/setup/abc ');
		submit();
		expect(store.mutate).toHaveBeenCalledWith({
			kind: 'preview',
			url: 'https://sodialed.com/setup/abc',
			carId: 'car-1',
		});
		expect(fixture.nativeElement.textContent).toContain('Reading sheet…');
		store.succeed({ kind: 'preview', preview });
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Review setup');
	});

	it('maps rejected, expired, and unavailable preview failures', () => {
		for (const [failure, message] of [
			[
				{ kind: 'rejected', message: 'Source is private.' },
				'Source is private.',
			],
			[{ kind: 'http', status: 401 }, 'Your garage session has expired'],
			[{ kind: 'unavailable' }, 'That source could not be read'],
		] as const) {
			enter('https://sodialed.com/setup/abc');
			submit();
			store.fail(failure);
			fixture.detectChanges();
			expect(fixture.nativeElement.textContent).toContain(message);
		}
	});

	it('resets on route changes, import cancellation, and imported save success', () => {
		enter('https://sodialed.com/setup/abc');
		fixture.componentRef.setInput('carId', 'car-2');
		fixture.detectChanges();
		expect(input().value).toBe('');

		enter('https://sodialed.com/setup/abc');
		store.outcome.set({
			status: 'pending',
			operationId: 10,
			command: { kind: 'cancel-import', draftId: 'draft-1' },
		});
		fixture.detectChanges();
		expect(input().value).toBe('');

		enter('https://sodialed.com/setup/abc');
		const setup = { id: 'setup-1', carId: 'car-2' } as SetupSnapshot;
		store.outcome.set({
			status: 'succeeded',
			operationId: 11,
			command: {
				kind: 'save',
				sourceCarId: 'car-1',
				targetCarId: 'car-2',
				mode: 'add',
				setupId: null,
				snapshot: { name: 'Imported' },
				importDraft: {
					draftId: 'draft-1',
					name: 'Imported',
					review: {
						carId: 'car-2',
						knownValues: {},
						uncertainValues: {},
						rawValues: {},
						unmappedValues: {},
						sourceMetadata: {},
					},
				},
			},
			result: { kind: 'save', setup, targetCarId: 'car-2' },
		});
		fixture.detectChanges();
		expect(input().value).toBe('');
	});

	it('guards missing, archived, and busy routes without leaving a loading state', () => {
		const harness = fixture.componentInstance as unknown as {
			previewImport(): void;
		};
		enter('https://sodialed.com/setup/abc');
		fixture.componentRef.setInput('carId', '');
		fixture.detectChanges();
		harness.previewImport();
		fixture.componentRef.setInput('carId', 'car-1');
		fixture.componentRef.setInput('archived', true);
		fixture.detectChanges();
		enter('https://sodialed.com/setup/abc');
		harness.previewImport();
		fixture.componentRef.setInput('archived', false);
		store.outcome.set({
			status: 'pending',
			operationId: 20,
			command: { kind: 'cancel-import', draftId: 'busy' },
		});
		fixture.detectChanges();
		enter('https://sodialed.com/setup/abc');
		harness.previewImport();
		expect(store.mutate).not.toHaveBeenCalled();

		store.outcome.set({ status: 'idle', operationId: null });
		store.mutate.mockImplementationOnce(() => undefined);
		harness.previewImport();
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Review setup');
	});
});
