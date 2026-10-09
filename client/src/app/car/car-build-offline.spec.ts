import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BuildSyncOperation } from './build-sync/build-sync.models';
import { CarBuild } from './car-build';
import { CarBuildStore } from './car-build-store';
import { CarStore } from './car-store';

describe('Build synchronization presentation', () => {
	afterEach(() => TestBed.resetTestingModule());
	it('announces pending/rejected/conflicting intent and preserves visible remote history', async () => {
		const current = {
			id: 'motor',
			carId: 'car',
			slot: 'motor',
			name: 'Local motor',
		};
		const car = signal({
			id: 'car',
			name: 'Buggy',
			archivedAt: null as string | null,
		});
		const action = signal<string | null>(null);
		const operations = signal<readonly BuildSyncOperation[]>([]);
		const build = {
			action,
			syncOperations: operations,
			outcome: signal({ status: 'idle', operationId: null }),
			error: () => '',
			message: () => '',
			loading: () => false,
			failure: () => null,
			groups: () => [{ slot: 'motor', current, history: [] }],
			selectCar: vi.fn(),
			clearOutcome: vi.fn(),
			save: vi.fn(),
		};
		await TestBed.configureTestingModule({
			imports: [CarBuild],
			providers: [
				provideRouter([]),
				{
					provide: CarStore,
					useValue: {
						car,
						loading: () => false,
						failure: () => null,
						selectCar: vi.fn(),
					},
				},
				{ provide: CarBuildStore, useValue: build },
			],
		}).compileComponents();
		const fixture = TestBed.createComponent(CarBuild);
		fixture.componentRef.setInput('carId', 'car');
		fixture.detectChanges();
		const operation = {
			operationId: 'op',
			status: 'pending',
			command: { input: { name: 'Local motor' } },
		} as BuildSyncOperation;
		operations.set([operation]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'Pending sync: Local motor',
		);
		operations.set([
			{
				...operation,
				status: 'needs-attention',
				feedback: { code: 'INVALID', message: 'Review the name.' },
			},
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Needs attention');
		operations.set([
			{
				...operation,
				status: 'conflict',
				remote: {
					carId: 'car',
					version: 3,
					components: [
						{ ...current, name: 'Remote motor' },
						{
							...current,
							id: 'old',
							name: 'Old motor',
							removedAt: '2026-01-01',
						},
					],
				},
			},
		]);
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain('Sync conflict');
		expect(fixture.nativeElement.textContent).toContain('Remote motor');
		expect(fixture.nativeElement.textContent).toContain(
			'Previous installation',
		);
		const remove = [...fixture.nativeElement.querySelectorAll('button')].find(
			(button: HTMLButtonElement) => button.textContent?.trim() === 'Remove',
		) as HTMLButtonElement;
		remove.click();
		expect(build.save).toHaveBeenCalledWith({
			mode: 'remove',
			componentId: 'motor',
			input: { name: 'Local motor', slot: 'motor', slotType: 'standard' },
		});
		const component = fixture.componentInstance as unknown as {
			remove(value: typeof current): void;
		};
		car.set({ ...car(), archivedAt: '2026-01-01' });
		component.remove(current);
		car.set({ ...car(), archivedAt: null });
		action.set('saving');
		component.remove(current);
		expect(build.save).toHaveBeenCalledOnce();
	});
});
