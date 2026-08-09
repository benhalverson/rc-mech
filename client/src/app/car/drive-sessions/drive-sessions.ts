import { DatePipe } from '@angular/common';
import {
	afterNextRender,
	Component,
	ElementRef,
	effect,
	Injector,
	inject,
	input,
	signal,
} from '@angular/core';
import {
	FormField,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import { RouterLink } from '@angular/router';
import {
	LucideArchive,
	LucideClock,
	LucideMic,
	LucidePencil,
	LucidePlus,
	LucideRefreshCw,
	LucideSave,
	LucideTriangleAlert,
} from '@lucide/angular';
import { CarSectionShell } from '../car-section-shell';
import { CarStore } from '../car-store';
import type { DriveSession } from './drive-session.models';
import { DriveSessionStore } from './drive-session-store';
import { localDateTime, toIso } from './drive-session-time';

type DriveSessionForm = {
	startedAt: string;
	durationMinutes: string;
	conditions: string;
	notes: string;
};

const emptyForm = (): DriveSessionForm => ({
	startedAt: '',
	durationMinutes: '',
	conditions: '',
	notes: '',
});

@Component({
	selector: 'app-drive-sessions',
	imports: [
		CarSectionShell,
		DatePipe,
		FormField,
		LucideArchive,
		LucideClock,
		LucideMic,
		LucidePencil,
		LucidePlus,
		LucideRefreshCw,
		LucideSave,
		LucideTriangleAlert,
		RouterLink,
	],
	templateUrl: './drive-sessions.html',
	host: { class: 'block' },
})
export class DriveSessions {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	protected readonly driveSessionStore = inject(DriveSessionStore);
	private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
	private readonly injector = inject(Injector);
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly form = signal(emptyForm());
	protected readonly driveSessionForm = signalForm(this.form, (path) => {
		required(path.startedAt, {
			message: 'Add when this drive session started.',
		});
		validate(path.durationMinutes, ({ value }) => {
			if (!value().trim()) return undefined;
			const duration = Number(value());
			return Number.isInteger(duration) && duration >= 1 && duration <= 1440
				? undefined
				: {
						kind: 'duration',
						message: 'Duration must be between 1 and 1,440 minutes.',
					};
		});
	});
	protected readonly formError = signal('');
	protected readonly message = signal('');
	private returnFocusTarget = 'record';
	private lastHandledOperationId = 0;

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
			this.carStore.selectCar(carId);
			this.driveSessionStore.selectCar(carId);
		});
		effect(() => {
			const outcome = this.driveSessionStore.outcome();
			if (
				outcome.status === 'idle' ||
				outcome.status === 'pending' ||
				outcome.operationId <= this.lastHandledOperationId
			)
				return;
			this.lastHandledOperationId = outcome.operationId;
			if (outcome.status === 'failed') {
				if (outcome.operation === 'save-drive-session')
					this.formError.set(this.driveSessionStore.error());
				else this.message.set(this.driveSessionStore.error());
				return;
			}
			if (outcome.operation === 'save-drive-session') {
				this.editing.set(false);
				this.focusAfterRender(() =>
					this.host.nativeElement.querySelector<HTMLElement>(
						'#drive-sessions-title',
					),
				);
				this.formError.set('');
				this.message.set(
					this.editingId()
						? 'Drive session updated.'
						: 'Drive session recorded.',
				);
			}
		});
	}

	private focusAfterRender(target: () => HTMLElement | null): void {
		afterNextRender(() => target()?.focus(), { injector: this.injector });
	}

	private focusEditorAfterRender(): void {
		this.focusAfterRender(() =>
			this.host.nativeElement.querySelector<HTMLElement>(
				'#drive-session-form-title',
			),
		);
	}

	private restoreLauncherFocusAfterRender(): void {
		this.focusAfterRender(() => {
			const controls = this.host.nativeElement.querySelectorAll<HTMLElement>(
				'[data-drive-session-launcher]',
			);
			return (
				[...controls].find(
					(control) =>
						control.dataset['driveSessionLauncher'] === this.returnFocusTarget,
				) ?? null
			);
		});
	}

	private resetRouteState(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.driveSessionForm().reset(emptyForm());
		this.formError.set('');
		this.message.set('');
		this.returnFocusTarget = 'record';
	}

	protected openAdd(): void {
		if (this.carStore.car()?.archivedAt || this.driveSessionStore.pending())
			return;
		this.returnFocusTarget = 'record';
		this.editingId.set(null);
		this.driveSessionForm().reset({
			...emptyForm(),
			startedAt: localDateTime(
				new Date().toISOString(),
				this.driveSessionStore.timezone(),
			),
		});
		this.editing.set(true);
		this.focusEditorAfterRender();
	}

	protected openEdit(session: DriveSession): void {
		if (
			this.carStore.car()?.archivedAt ||
			session.deletedAt ||
			this.driveSessionStore.pending()
		)
			return;
		this.returnFocusTarget = session.id;
		this.editingId.set(session.id);
		this.driveSessionForm().reset({
			startedAt: localDateTime(
				session.startedAt,
				this.driveSessionStore.timezone(),
			),
			durationMinutes: session.durationMinutes
				? String(session.durationMinutes)
				: '',
			conditions: session.conditions ?? '',
			notes: session.notes ?? '',
		});
		this.editing.set(true);
		this.focusEditorAfterRender();
	}

	protected cancel(): void {
		if (this.driveSessionStore.pending()) return;
		this.editing.set(false);
		this.formError.set('');
		this.driveSessionForm().reset();
		this.restoreLauncherFocusAfterRender();
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		if (this.driveSessionStore.pending()) return;
		this.formError.set('');
		this.message.set('');
		this.driveSessionForm().markAsTouched();
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.formError.set('Restore this car before recording a drive session.');
			return;
		}
		const duration = form.durationMinutes.trim()
			? Number(form.durationMinutes)
			: null;
		if (this.driveSessionForm().invalid()) {
			this.formError.set('Review the highlighted drive session fields.');
			if (this.driveSessionForm.startedAt().invalid())
				this.driveSessionForm.startedAt().focusBoundControl();
			else this.driveSessionForm.durationMinutes().focusBoundControl();
			return;
		}
		this.driveSessionStore.saveDriveSession({
			carId: car.id,
			sessionId: this.editingId(),
			draft: {
				startedAt: toIso(form.startedAt, this.driveSessionStore.timezone()),
				durationMinutes: duration,
				conditions: form.conditions.trim(),
				notes: form.notes.trim(),
			},
		});
	}

	protected archive(session: DriveSession): void {
		const car = this.carStore.car();
		if (!car || car.archivedAt || this.driveSessionStore.pending()) return;
		this.message.set('');
		this.driveSessionStore.archiveDriveSession({
			carId: car.id,
			sessionId: session.id,
		});
	}
}
