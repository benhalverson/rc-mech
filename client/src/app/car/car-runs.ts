import { DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { Component, effect, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
	FormField,
	required,
	form as signalForm,
	validate,
} from '@angular/forms/signals';
import type { DriveSession } from './car.models';
import { CarRunsStore, safeTimezone } from './car-runs-store';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

type DriveForm = {
	startedAt: string;
	durationMinutes: string;
	conditions: string;
	notes: string;
};

const localDateTime = (iso: string, timezone: string): string => {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: safeTimezone(timezone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(iso));
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};

const toIso = (value: string, timezone: string): string => {
	const [date, time] = value.split('T');
	if (!date || !time) return '';
	const [year, month, day] = date.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);
	const asUtc = Date.UTC(year, month - 1, day, hour, minute);
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: safeTimezone(timezone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(asUtc));
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const offset =
		Date.UTC(
			get('year'),
			get('month') - 1,
			get('day'),
			get('hour'),
			get('minute'),
		) - asUtc;
	return new Date(asUtc - offset).toISOString();
};

const emptyForm = (): DriveForm => ({
	startedAt: '',
	durationMinutes: '',
	conditions: '',
	notes: '',
});

@Component({
	selector: 'app-car-runs',
	imports: [CarSectionShell, DatePipe, FormField, RouterLink],
	template: `
		@if (carStore.loading()) { <div class="state-card" role="status">Opening the car record…</div> }
		@else if (carStore.failure(); as failure) { <div class="state-card" role="alert"><p>{{ failure.message }}</p>@if (failure.retryable) { <button type="button" (click)="carStore.retry()">Try again</button> }</div> }
		@else if (carStore.car(); as car) {
			<app-car-section-shell [car]="car" section="runs">
				<section class="session-log" aria-labelledby="runs-title">
					<div class="section-heading"><div><div class="eyebrow">Drive history</div><h3 id="runs-title">The run log</h3></div><span><strong>{{ runsStore.activeCount() }}</strong> recorded</span>@if (!car.archivedAt && !editing()) { <a class="button" [routerLink]="['/garage', car.id, 'voice']">Voice track log</a><button class="button" type="button" (click)="openAdd()" [disabled]="action() !== null">Record a drive</button> }</div>
					@if (editing()) { <form (submit)="save($event)" aria-labelledby="run-form-title" [attr.aria-describedby]="formError() ? 'run-form-error' : null" novalidate><h4 id="run-form-title">{{ editingId() ? 'Edit drive session' : 'Record a drive' }}</h4>@if (formError()) { <p id="run-form-error" role="alert">{{ formError() }}</p> }<div class="form-grid"><label>Started <input type="datetime-local" [formField]="runForm.startedAt" [attr.aria-describedby]="runForm.startedAt().invalid() && formError() ? 'run-form-error' : null" /></label><label>Duration (minutes) <input type="text" inputmode="numeric" [formField]="runForm.durationMinutes" [attr.aria-describedby]="runForm.durationMinutes().invalid() && formError() ? 'run-form-error' : null" /></label><label class="wide">Conditions <input [formField]="runForm.conditions" /></label><label class="wide">Notes <textarea rows="3" [formField]="runForm.notes"></textarea></label></div><p>Saved in {{ runsStore.timezone() }}.</p><div class="form-actions"><button class="button" type="submit" [disabled]="action() !== null">Save session</button><button type="button" (click)="cancel()" [disabled]="action() !== null">Cancel</button></div></form> }
					@else if (runsStore.loading()) { <div class="state-card" role="status">Opening the run log…</div> }
					@else if (runsStore.failure(); as failure) { <div class="state-card" role="alert"><p>{{ failure.message }}</p>@if (failure.retryable) { <button type="button" (click)="runsStore.retry()">Try again</button> }</div> }
					@else if (!runsStore.sessions().length) { <div class="state-card"><h4>No drive sessions recorded</h4>@if (!car.archivedAt) { <button type="button" (click)="openAdd()" [disabled]="action() !== null">Record the first drive</button> }</div> }
					@else { <div class="session-list" aria-label="Drive session history">@for (session of runsStore.sessions(); track session.id) { <article class="session-row"><div><time [dateTime]="session.startedAt">{{ session.startedAt | date:'medium':runsStore.timezone() }}</time></div><div><strong>{{ session.conditions || 'Conditions not recorded' }}</strong>@if (session.durationMinutes) { <span> · {{ session.durationMinutes }} min</span> }@if (session.notes) { <p>{{ session.notes }}</p> }</div>@if (!session.deletedAt && !car.archivedAt) { <div class="form-actions"><button type="button" (click)="openEdit(session)" [disabled]="action() !== null">Edit</button><button type="button" (click)="archive(session)" [disabled]="action() !== null">Archive</button></div> }</article> }</div> }
					@if (message()) { <p role="status">{{ message() }}</p> }
				</section>
			</app-car-section-shell>
		}
	`,
	styleUrl: '../garage-pages.css',
})
export class CarRuns {
	readonly carId = input('');
	protected readonly carStore = inject(CarStore);
	protected readonly runsStore = inject(CarRunsStore);
	private readonly http = inject(HttpClient);
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
	protected readonly form = signal(emptyForm());
	protected readonly runForm = signalForm(this.form, (path) => {
		required(path.startedAt, { message: 'Add when this drive started.' });
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

	constructor() {
		let previousCarId: string | undefined;
		effect(() => {
			const carId = this.carId();
			if (!carId) return;
			if (previousCarId !== undefined && carId !== previousCarId)
				this.resetRouteState();
			previousCarId = carId;
			this.carStore.selectCar(carId);
			this.runsStore.selectCar(carId);
		});
	}

	private resetRouteState(): void {
		this.editing.set(false);
		this.editingId.set(null);
		this.action.set(null);
		this.runForm().reset(emptyForm());
		this.formError.set('');
		this.message.set('');
	}

	protected openAdd(): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		this.editingId.set(null);
		this.runForm().reset({
			...emptyForm(),
			startedAt: localDateTime(
				new Date().toISOString(),
				this.runsStore.timezone(),
			),
		});
		this.editing.set(true);
	}

	protected openEdit(session: DriveSession): void {
		if (this.carStore.car()?.archivedAt || session.deletedAt || this.action())
			return;
		this.editingId.set(session.id);
		this.runForm().reset({
			startedAt: localDateTime(session.startedAt, this.runsStore.timezone()),
			durationMinutes: session.durationMinutes
				? String(session.durationMinutes)
				: '',
			conditions: session.conditions ?? '',
			notes: session.notes ?? '',
		});
		this.editing.set(true);
	}

	protected cancel(): void {
		if (this.action()) return;
		this.editing.set(false);
		this.formError.set('');
		this.runForm().reset();
	}

	protected save(event?: Event): void {
		event?.preventDefault();
		if (this.action()) return;
		this.formError.set('');
		this.message.set('');
		this.runForm().markAsTouched();
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.formError.set('Restore this car before recording a drive.');
			return;
		}
		const duration = form.durationMinutes.trim()
			? Number(form.durationMinutes)
			: null;
		if (this.runForm().invalid()) {
			this.formError.set(
				this.runForm().errorSummary()[0]?.message ??
					'Review the drive session fields.',
			);
			if (this.runForm.startedAt().invalid())
				this.runForm.startedAt().focusBoundControl();
			else this.runForm.durationMinutes().focusBoundControl();
			return;
		}
		const id = this.editingId();
		this.action.set(id ? 'edit' : 'add');
		const body = {
			startedAt: toIso(form.startedAt, this.runsStore.timezone()),
			durationMinutes: duration,
			conditions: form.conditions.trim(),
			notes: form.notes.trim(),
		};
		const request = id
			? this.http.patch(
					`/api/v1/cars/${encodeURIComponent(car.id)}/drives/${encodeURIComponent(id)}`,
					body,
					{ withCredentials: true },
				)
			: this.http.post(
					`/api/v1/cars/${encodeURIComponent(car.id)}/drives`,
					body,
					{
						withCredentials: true,
					},
				);
		request.subscribe({
			next: () => {
				if (this.carId() !== car.id) return;
				this.runsStore.refresh();
				this.action.set(null);
				this.editing.set(false);
				this.message.set(
					id ? 'Drive session updated.' : 'Drive session recorded.',
				);
			},
			error: (error: { status?: number }) => {
				if (this.carId() !== car.id) return;
				this.action.set(null);
				this.formError.set(
					error.status === 401
						? 'Your garage session has expired. Sign in again to continue.'
						: error.status === 409
							? 'Restore this car before recording a drive.'
							: 'The drive session could not be saved.',
				);
			},
		});
	}

	protected archive(session: DriveSession): void {
		const car = this.carStore.car();
		if (!car || car.archivedAt || this.action()) return;
		this.message.set('');
		this.action.set(`delete:${session.id}`);
		this.http
			.delete(
				`/api/v1/cars/${encodeURIComponent(car.id)}/drives/${encodeURIComponent(session.id)}`,
				{ withCredentials: true },
			)
			.subscribe({
				next: () => {
					if (this.carId() !== car.id) return;
					this.runsStore.refresh();
					this.action.set(null);
				},
				error: (error: { status?: number }) => {
					if (this.carId() !== car.id) return;
					this.action.set(null);
					this.message.set(
						error.status === 401
							? 'Your garage session has expired. Sign in again to continue.'
							: 'The drive session could not be archived.',
					);
				},
			});
	}
}
