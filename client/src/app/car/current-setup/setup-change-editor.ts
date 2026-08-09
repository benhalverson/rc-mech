import {
	afterNextRender,
	Component,
	computed,
	ElementRef,
	effect,
	inject,
	input,
	OnInit,
	output,
	signal,
} from '@angular/core';
import {
	FormField,
	form,
	maxLength,
	required,
	validate,
} from '@angular/forms/signals';
import type { CurrentSetupSnapshot } from './current-setup.models';
import { CurrentSetupStore } from './current-setup-store';
import {
	emptySetupChangeForm,
	type SetupChangeFormModel,
	setupChangeDraftFromForm,
	setupChangeRemainingGroups,
} from './setup-change.rules';

const validationMessage = 'Review the highlighted setup fields before saving.';

@Component({
	selector: 'app-setup-change-editor',
	imports: [FormField],
	templateUrl: './setup-change-editor.html',
	host: { class: 'block' },
})
export class SetupChangeEditor implements OnInit {
	readonly carId = input.required<string>();
	readonly setup = input.required<CurrentSetupSnapshot>();
	readonly initialForm = input.required<SetupChangeFormModel>();
	readonly initialFocus = input('name');
	readonly cancelled = output<void>();
	readonly completed = output<void>();
	protected readonly store = inject(CurrentSetupStore);
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	protected readonly formModel = signal(emptySetupChangeForm());
	protected readonly setupForm = form(this.formModel, (path) => {
		required(path.name, { message: 'Name this setup before saving.' });
		validate(path.name, ({ value }) =>
			!value() || value().trim()
				? undefined
				: {
						kind: 'blankName',
						message: 'Name this setup before saving.',
					},
		);
		maxLength(path.name, 160, { message: 'Use 160 characters or fewer.' });
		maxLength(path.track, 160, {
			message: 'Use 160 characters or fewer for the track.',
		});
		maxLength(path.event, 160, {
			message: 'Use 160 characters or fewer for the event.',
		});
		for (const field of [
			path.surface,
			path.traction,
			path.moisture,
			path.condition,
		])
			maxLength(field, 120, { message: 'Use 120 characters or fewer.' });
		maxLength(path.temperature, 80, {
			message: 'Use 80 characters or fewer for temperature.',
		});
	});
	private readonly validationError = signal('');
	protected readonly formError = computed(
		() => this.validationError() || this.store.saveError(),
	);
	protected readonly remainingGroups = computed(() =>
		setupChangeRemainingGroups(this.setup()),
	);
	protected readonly isTwoWheel = computed(() =>
		/(?:\b2\s*wd\b|two[ -]?wheel)/i.test(
			this.formModel().sections.drivetrain['driveType'],
		),
	);
	protected readonly isFourWheel = computed(() =>
		/(?:\b4\s*wd\b|four[ -]?wheel)/i.test(
			this.formModel().sections.drivetrain['driveType'],
		),
	);
	protected readonly drivetrainUnknown = computed(
		() => !this.isTwoWheel() && !this.isFourWheel(),
	);
	protected readonly decoupledCenter = computed(() =>
		/decoupled/i.test(this.formModel().sections.drivetrain['centerSlipper']),
	);
	protected readonly pillPositions = [
		'up/in',
		'up/center',
		'up/out',
		'center/in',
		'center/center',
		'center/out',
		'down/in',
		'down/center',
		'down/out',
	] as const;
	private submitted = false;

	constructor() {
		afterNextRender(() => this.focusInitialControl());
		effect(() => {
			if (
				!this.setupForm().invalid() &&
				this.validationError() === validationMessage
			)
				this.validationError.set('');
		});
		effect(() => {
			const outcome = this.store.outcome();
			if (!this.submitted || outcome.status !== 'succeeded') return;
			this.submitted = false;
			this.completed.emit();
		});
	}

	ngOnInit(): void {
		this.setupForm().reset(this.initialForm());
	}

	protected pillLabel(position: string): string {
		const [vertical, horizontal] = position.split('/');
		return `${vertical} / ${horizontal}`;
	}

	protected cancel(): void {
		if (this.store.pending()) return;
		this.submitted = false;
		this.cancelled.emit();
	}

	protected save(event: Event): void {
		event.preventDefault();
		this.setupForm().markAsTouched();
		if (this.setupForm().invalid()) {
			this.validationError.set(validationMessage);
			this.focusFirstInvalidControl();
			return;
		}
		if (this.store.pending()) return;
		this.validationError.set('');
		this.submitted = true;
		this.store.saveCurrentSetup({
			carId: this.carId(),
			sourceSetupId: this.setup().id,
			sourceUpdatedAt: this.setup().updatedAt ?? '',
			draft: setupChangeDraftFromForm(this.setup(), this.formModel()),
		});
	}

	private focusFirstInvalidControl(): void {
		for (const field of [
			this.setupForm.name,
			this.setupForm.track,
			this.setupForm.event,
			this.setupForm.surface,
			this.setupForm.traction,
			this.setupForm.moisture,
			this.setupForm.condition,
			this.setupForm.temperature,
		]) {
			if (!field().invalid()) continue;
			field().focusBoundControl();
			return;
		}
	}

	private focusInitialControl(): void {
		const requested = this.initialFocus();
		const controls =
			this.host.nativeElement.querySelectorAll<HTMLElement>(
				'[data-setup-field]',
			);
		const control = [...controls].find(
			(candidate) => candidate.dataset['setupField'] === requested,
		);
		(control ?? controls.item(0))?.focus();
	}
}
