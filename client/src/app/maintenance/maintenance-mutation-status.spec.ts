import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import { MaintenanceMutationStatus } from './maintenance-mutation-status';
import {
	type MaintenancePlanOutcome,
	MaintenancePlanStore,
} from './maintenance-plan-store';
import {
	type ServiceRecordOutcome,
	ServiceRecordStore,
} from './service-record-store';

const planIdle: MaintenancePlanOutcome = { status: 'idle', operationId: null };
const serviceIdle: ServiceRecordOutcome = {
	status: 'idle',
	operationId: null,
};

describe('MaintenanceMutationStatus', () => {
	let fixture: ComponentFixture<MaintenanceMutationStatus>;
	let planOutcome: ReturnType<typeof signal<MaintenancePlanOutcome>>;
	let serviceOutcome: ReturnType<typeof signal<ServiceRecordOutcome>>;

	beforeEach(async () => {
		planOutcome = signal(planIdle);
		serviceOutcome = signal(serviceIdle);
		await TestBed.configureTestingModule({
			imports: [MaintenanceMutationStatus],
			providers: [
				{ provide: MaintenancePlanStore, useValue: { outcome: planOutcome } },
				{ provide: ServiceRecordStore, useValue: { outcome: serviceOutcome } },
			],
		}).compileComponents();
		fixture = TestBed.createComponent(MaintenanceMutationStatus);
		fixture.detectChanges();
	});

	it('renders only top-level plan-transition and completion-undo failures', () => {
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
		planOutcome.set({
			status: 'failed',
			operationId: 1,
			command: {
				kind: 'transition-plan',
				planId: 'plan-1',
				action: 'pause',
			},
			failure: 'transition-failed',
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'That maintenance update could not be saved.',
		);

		planOutcome.set(planIdle);
		serviceOutcome.set({
			status: 'failed',
			operationId: 2,
			command: { kind: 'undo-activity', recordId: 'record-1' },
			failure: 'undo-failed',
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.textContent).toContain(
			'That completion could not be undone.',
		);

		serviceOutcome.set({
			status: 'failed',
			operationId: 3,
			command: {
				kind: 'change-service',
				recordId: 'record-1',
				action: 'archive',
			},
			failure: 'archive-failed',
		});
		fixture.detectChanges();
		expect(fixture.nativeElement.querySelector('[role="alert"]')).toBeNull();
	});
});
