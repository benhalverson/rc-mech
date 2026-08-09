import { DOCUMENT } from '@angular/common';
import {
	afterNextRender,
	Component,
	effect,
	Injector,
	inject,
	input,
	linkedSignal,
	output,
	signal,
	untracked,
} from '@angular/core';
import {
	FormField,
	maxLength,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import { LucideSave, LucideTriangleAlert } from '@lucide/angular';
import type {
	MaintenancePlan,
	MaintenancePlanDraft,
} from './maintenance.models';
import { localDateTime, localDateTimeToIso } from './maintenance-plan.rules';
import {
	type MaintenancePlanFailure,
	MaintenancePlanStore,
} from './maintenance-plan-store';

export type MaintenancePlanEditorRequest =
	| { readonly kind: 'create' }
	| { readonly kind: 'edit'; readonly plan: MaintenancePlan };

export type MaintenancePlanForm = {
	carId: string;
	componentId: string;
	name: string;
	calendarValue: string;
	calendarUnit: 'days' | 'weeks' | 'months';
	sessionInterval: string;
	baselineAt: string;
	baselineSessions: string;
};

const emptyForm = (): MaintenancePlanForm => ({
	carId: '',
	componentId: '',
	name: '',
	calendarValue: '',
	calendarUnit: 'weeks',
	sessionInterval: '',
	baselineAt: '',
	baselineSessions: '0',
});

@Component({
	selector: 'app-maintenance-plan-editor',
	imports: [FormField, LucideSave, LucideTriangleAlert],
	templateUrl: './maintenance-plan-editor.html',
	host: { class: 'contents' },
})
export class MaintenancePlanEditor {
	private readonly store = inject(MaintenancePlanStore);
	private readonly document = inject(DOCUMENT);
	private readonly injector = inject(Injector);
	private readonly returnFocusSelector = signal(
		'[data-maintenance-launcher="new-plan"]',
	);
	private readonly handledOperationId = signal(0);

	readonly request = input<MaintenancePlanEditorRequest | null>(null);
	readonly cancelled = output<void>();
	readonly saved = output<void>();

	protected readonly garage = linkedSignal(() => this.store.cars());
	protected readonly timezone = this.store.timezone;
	protected readonly components = this.store.components;
	protected readonly action = this.store.action;
	protected readonly formError = signal('');
	protected readonly form = signal<MaintenancePlanForm>(emptyForm());
	protected readonly fields = signalForm(this.form, (path) => {
		required(path.carId, { message: 'Choose a car.' });
		required(path.name, { message: 'Name the care rule.' });
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: { kind: 'blankName', message: 'Name the care rule.' },
		);
		maxLength(path.name, 160, {
			message: 'Use 160 characters or fewer for the plan name.',
		});
		for (const interval of [path.calendarValue, path.sessionInterval])
			validate(interval, ({ value }) => {
				const intervalValue = value().trim();
				if (!intervalValue) return undefined;
				if (!/^\d+$/.test(intervalValue))
					return {
						kind: 'wholeNumber',
						message: 'Intervals must be whole numbers.',
					};
				return Number(intervalValue) >= 1
					? undefined
					: { kind: 'minimum', message: 'Intervals must be at least one.' };
			});
		validate(path.calendarValue, (context) =>
			!context.value().trim() && !context.valueOf(path.sessionInterval).trim()
				? {
						kind: 'intervalRequired',
						message:
							'Add a calendar interval, a drive-session threshold, or both.',
					}
				: undefined,
		);
		validate(path.sessionInterval, (context) =>
			!context.value().trim() && !context.valueOf(path.calendarValue).trim()
				? {
						kind: 'intervalRequired',
						message:
							'Add a calendar interval, a drive-session threshold, or both.',
					}
				: undefined,
		);
		validate(path.baselineSessions, ({ value }) =>
			!value().trim() || /^\d+$/.test(value().trim())
				? undefined
				: {
						kind: 'wholeNumber',
						message: 'Prior sessions must be a whole number.',
					},
		);
	});

	constructor() {
		effect(() => {
			const request = this.request();
			if (request) untracked(() => this.open(request));
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId === this.handledOperationId()
			)
				return;
			this.handledOperationId.set(outcome.operationId);
			if (outcome.command.kind !== 'save-plan') return;
			if (outcome.status === 'failed') {
				this.formError.set(this.failureMessage(outcome.failure));
				return;
			}
			this.returnFocusSelector.set('#maintenance-title');
			this.close(this.saved);
		});
	}

	protected cancel(): void {
		this.close(this.cancelled);
	}

	protected changeCar(event: Event): void {
		if (!(event.target instanceof HTMLSelectElement)) return;
		const carId = event.target.value;
		this.form.update((current) => ({ ...current, carId }));
		this.store.loadComponents(carId);
	}

	protected save(event: Event): void {
		event.preventDefault();
		this.fields().markAsTouched();
		const form = this.form();
		const calendar = form.calendarValue.trim()
			? Number(form.calendarValue)
			: null;
		const sessions = form.sessionInterval.trim()
			? Number(form.sessionInterval)
			: null;
		if (this.fields().invalid()) {
			this.formError.set(
				this.fields().errorSummary()[0]?.message ??
					'Review the maintenance plan fields.',
			);
			if (this.fields.carId().invalid())
				this.fields.carId().focusBoundControl();
			else if (this.fields.name().invalid())
				this.fields.name().focusBoundControl();
			else if (this.fields.calendarValue().invalid())
				this.fields.calendarValue().focusBoundControl();
			else if (this.fields.sessionInterval().invalid())
				this.fields.sessionInterval().focusBoundControl();
			else this.fields.baselineSessions().focusBoundControl();
			return;
		}
		if (
			(calendar !== null && (!Number.isInteger(calendar) || calendar < 1)) ||
			(sessions !== null && (!Number.isInteger(sessions) || sessions < 1))
		) {
			this.formError.set('Intervals must be whole numbers greater than zero.');
			return;
		}
		if (calendar === null && sessions === null) {
			this.formError.set(
				'Add a calendar interval, a drive-session threshold, or both.',
			);
			return;
		}
		if (this.action()) return;
		const plan: MaintenancePlanDraft = {
			carId: form.carId,
			componentId: form.componentId || undefined,
			name: form.name.trim(),
			intervalUnit: calendar === null ? 'none' : form.calendarUnit,
			intervalValue: calendar === null ? 1 : calendar,
			...(calendar !== null && form.calendarUnit === 'days'
				? { intervalDays: calendar }
				: {}),
			intervalSessions: sessions === null ? undefined : sessions,
			baselineAt: form.baselineAt
				? localDateTimeToIso(form.baselineAt, this.timezone())
				: undefined,
			baselineSessionCount: Number(form.baselineSessions) || 0,
		};
		const request = this.request();
		if (!request) return;
		this.formError.set('');
		this.store.mutate({
			kind: 'save-plan',
			mode: request.kind === 'edit' ? 'edit' : 'create',
			id: request.kind === 'edit' ? request.plan.id : null,
			plan,
		});
	}

	private open(request: MaintenancePlanEditorRequest): void {
		if (request.kind === 'create') {
			const firstCar = this.garage().find((car) => !car.archivedAt);
			if (!firstCar) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set('[data-maintenance-launcher="new-plan"]');
			this.fields().reset({
				...emptyForm(),
				carId: firstCar.id,
				baselineAt: localDateTime(new Date(), this.timezone()),
			});
			this.store.loadComponents(firstCar.id);
		} else {
			const plan = request.plan;
			if (this.isReadOnly(plan)) {
				this.cancelled.emit();
				return;
			}
			this.returnFocusSelector.set(
				`[data-maintenance-launcher="plan:${plan.id}"]`,
			);
			this.fields().reset({
				...emptyForm(),
				carId: plan.carId,
				componentId: plan.componentId ?? '',
				name: plan.name,
				calendarValue:
					plan.intervalUnit === 'none'
						? ''
						: plan.intervalValue
							? String(plan.intervalValue)
							: plan.intervalDays
								? String(plan.intervalDays)
								: '',
				calendarUnit:
					plan.intervalUnit === 'weeks' || plan.intervalUnit === 'months'
						? plan.intervalUnit
						: 'days',
				sessionInterval: plan.intervalSessions
					? String(plan.intervalSessions)
					: '',
				baselineAt: plan.baselineAt
					? localDateTime(new Date(plan.baselineAt), this.timezone())
					: '',
				baselineSessions: String(plan.baselineSessionCount ?? 0),
			});
			this.store.loadComponents(plan.carId);
		}
		this.formError.set('');
		this.focusAfterRender('#maintenance-form-title');
	}

	private close(intent: { emit(): void }): void {
		this.formError.set('');
		this.fields().reset();
		intent.emit();
		this.focusAfterRender(this.returnFocusSelector());
	}

	private failureMessage(failure: MaintenancePlanFailure): string {
		return failure === 'session-expired'
			? 'Your garage session has expired. Sign in again to continue.'
			: failure === 'car-archived'
				? 'This car is archived. Restore it before changing maintenance.'
				: 'The maintenance plan could not be saved.';
	}

	private isReadOnly(plan: MaintenancePlan): boolean {
		return (
			Boolean(this.garage().find((car) => car.id === plan.carId)?.archivedAt) ||
			plan.status === 'archived'
		);
	}

	private focusAfterRender(selector: string): void {
		afterNextRender(
			() => this.document.querySelector<HTMLElement>(selector)?.focus(),
			{ injector: this.injector },
		);
	}
}
