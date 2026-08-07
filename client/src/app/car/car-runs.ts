import { DatePipe } from '@angular/common';
import { HttpClient, httpResource } from '@angular/common/http';
import {
	Component,
	computed,
	effect,
	inject,
	input,
	signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { CarSectionShell } from './car-section-shell';
import { CarStore } from './car-store';

export type DriveSession = {
	id: string;
	carId: string;
	startedAt: string;
	durationMinutes?: number | null;
	conditions?: string | null;
	notes?: string | null;
	deletedAt?: string | null;
};

type DriveForm = {
	startedAt: string;
	durationMinutes: string;
	conditions: string;
	notes: string;
};

const safeTimezone = (timezone: string): string => {
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format();
		return timezone;
	} catch {
		return 'UTC';
	}
};

const browserTimezone = (): string => {
	try {
		return safeTimezone(
			Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC',
		);
	} catch {
		return 'UTC';
	}
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
	imports: [CarSectionShell, DatePipe, FormsModule],
	template: `
		@if (carStore.loading()) { <div class="state-card" role="status">Opening the car record…</div> }
		@else if (carStore.error()) { <div class="state-card" role="alert"><p>{{ carStore.error() }}</p>@if (!carStore.notFound()) { <button type="button" (click)="carStore.retry()">Try again</button> }</div> }
		@else if (carStore.car(); as car) {
			<app-car-section-shell [car]="car" section="runs">
				<section class="session-log" aria-labelledby="runs-title">
					<div class="section-heading"><div><div class="eyebrow">Drive history</div><h3 id="runs-title">The run log</h3></div><span><strong>{{ activeCount() }}</strong> recorded</span>@if (!car.archivedAt && !editing()) { <button class="button" type="button" (click)="openAdd()" [disabled]="action() !== null">Record a drive</button> }</div>
					@if (editing()) { <form (ngSubmit)="save()" aria-labelledby="run-form-title"><h4 id="run-form-title">{{ editingId() ? 'Edit drive session' : 'Record a drive' }}</h4>@if (formError()) { <p role="alert">{{ formError() }}</p> }<div class="form-grid"><label>Started <input name="started" type="datetime-local" required [ngModel]="form().startedAt" (ngModelChange)="update('startedAt', $event)" /></label><label>Duration (minutes) <input name="duration" type="number" min="1" max="1440" [ngModel]="form().durationMinutes" (ngModelChange)="update('durationMinutes', $event)" /></label><label class="wide">Conditions <input name="conditions" [ngModel]="form().conditions" (ngModelChange)="update('conditions', $event)" /></label><label class="wide">Notes <textarea name="notes" rows="3" [ngModel]="form().notes" (ngModelChange)="update('notes', $event)"></textarea></label></div><p>Saved in {{ timezone() }}.</p><div class="form-actions"><button class="button" type="submit" [disabled]="action() !== null">Save session</button><button type="button" (click)="cancel()" [disabled]="action() !== null">Cancel</button></div></form> }
					@else if (sessionsResource.isLoading()) { <div class="state-card" role="status">Opening the run log…</div> }
					@else if (sessionsResource.error()) { <div class="state-card" role="alert"><p>The run log could not be loaded.</p><button type="button" (click)="sessionsResource.reload()">Try again</button></div> }
					@else if (!sessions().length) { <div class="state-card"><h4>No drive sessions recorded</h4>@if (!car.archivedAt) { <button type="button" (click)="openAdd()" [disabled]="action() !== null">Record the first drive</button> }</div> }
					@else { <div class="session-list" aria-label="Drive session history">@for (session of sessions(); track session.id) { <article class="session-row"><div><time [dateTime]="session.startedAt">{{ session.startedAt | date:'medium':timezone() }}</time></div><div><strong>{{ session.conditions || 'Conditions not recorded' }}</strong>@if (session.durationMinutes) { <span> · {{ session.durationMinutes }} min</span> }<p>{{ session.notes }}</p></div>@if (!session.deletedAt && !car.archivedAt) { <div class="form-actions"><button type="button" (click)="openEdit(session)" [disabled]="action() !== null">Edit</button><button type="button" (click)="archive(session)" [disabled]="action() !== null">Archive</button></div> }</article> }</div> }
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
	private readonly http = inject(HttpClient);
	protected readonly sessionsResource = httpResource<{
		driveSessions?: DriveSession[];
		sessions?: DriveSession[];
	}>(() => {
		const carId = this.carId();
		return carId
			? {
					url: `/api/v1/cars/${encodeURIComponent(carId)}/drives`,
					withCredentials: true,
					params: { history: 'true' },
				}
			: undefined;
	});
	private readonly timezoneResource = httpResource<{ timezone?: string }>(
		() => ({
			url: '/api/v1/preferences/timezone',
			withCredentials: true,
		}),
	);
	protected readonly sessions = computed(() =>
		this.sessionsResource.hasValue()
			? (this.sessionsResource.value().driveSessions ??
				this.sessionsResource.value().sessions ??
				[])
			: [],
	);
	protected readonly activeCount = computed(
		() => this.sessions().filter((session) => !session.deletedAt).length,
	);
	protected readonly timezone = computed(() =>
		this.timezoneResource.hasValue()
			? (this.timezoneResource.value().timezone ?? browserTimezone())
			: browserTimezone(),
	);
	protected readonly editing = signal(false);
	protected readonly editingId = signal<string | null>(null);
	protected readonly action = signal<string | null>(null);
	protected readonly form = signal(emptyForm());
	protected readonly formError = signal('');
	protected readonly message = signal('');

	constructor() {
		effect(() => {
			const carId = this.carId();
			if (carId) this.carStore.selectCar(carId);
		});
	}

	protected openAdd(): void {
		if (this.carStore.car()?.archivedAt || this.action()) return;
		this.editingId.set(null);
		this.form.set({
			...emptyForm(),
			startedAt: localDateTime(new Date().toISOString(), this.timezone()),
		});
		this.editing.set(true);
	}

	protected openEdit(session: DriveSession): void {
		if (this.carStore.car()?.archivedAt || session.deletedAt || this.action())
			return;
		this.editingId.set(session.id);
		this.form.set({
			startedAt: localDateTime(session.startedAt, this.timezone()),
			durationMinutes: session.durationMinutes
				? String(session.durationMinutes)
				: '',
			conditions: session.conditions ?? '',
			notes: session.notes ?? '',
		});
		this.editing.set(true);
	}

	protected update(field: keyof DriveForm, value: unknown): void {
		this.form.update((form) => ({
			...form,
			[field]: value == null ? '' : String(value),
		}));
	}

	protected cancel(): void {
		if (this.action()) return;
		this.editing.set(false);
		this.formError.set('');
	}

	protected save(): void {
		if (this.action()) return;
		const car = this.carStore.car();
		const form = this.form();
		if (!car || car.archivedAt) {
			this.formError.set('Restore this car before recording a drive.');
			return;
		}
		const duration = form.durationMinutes.trim()
			? Number(form.durationMinutes)
			: null;
		if (!form.startedAt) {
			this.formError.set('Add when this drive started.');
			return;
		}
		if (
			duration !== null &&
			(!Number.isInteger(duration) || duration < 1 || duration > 1440)
		) {
			this.formError.set('Duration must be between 1 and 1,440 minutes.');
			return;
		}
		const id = this.editingId();
		this.action.set(id ? 'edit' : 'add');
		const body = {
			startedAt: toIso(form.startedAt, this.timezone()),
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
				this.sessionsResource.reload();
				this.action.set(null);
				this.editing.set(false);
				this.message.set(
					id ? 'Drive session updated.' : 'Drive session recorded.',
				);
			},
			error: (error: { status?: number }) => {
				this.action.set(null);
				this.formError.set(
					error.status === 409
						? 'Restore this car before recording a drive.'
						: 'The drive session could not be saved.',
				);
			},
		});
	}

	protected archive(session: DriveSession): void {
		const car = this.carStore.car();
		if (!car || car.archivedAt || this.action()) return;
		this.action.set(`delete:${session.id}`);
		this.http
			.delete(
				`/api/v1/cars/${encodeURIComponent(car.id)}/drives/${encodeURIComponent(session.id)}`,
				{ withCredentials: true },
			)
			.subscribe({
				next: () => {
					this.sessionsResource.reload();
					this.action.set(null);
				},
				error: () => {
					this.action.set(null);
					this.message.set('The drive session could not be archived.');
				},
			});
	}
}
