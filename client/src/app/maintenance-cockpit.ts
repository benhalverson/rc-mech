import { CommonModule, DatePipe } from '@angular/common';
import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, Input, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

export type MaintenanceCar = { id: string; name: string; archivedAt?: string | null };
export type MaintenanceComponent = { id: string; carId: string; slot: string; name: string; removedAt?: string | null };
export type MaintenancePlan = {
  id: string;
  carId: string;
  componentId: string;
  name: string;
  intervalDays?: number | null;
  intervalUnit?: 'days' | 'weeks' | 'months' | null;
  intervalValue?: number | null;
  intervalSessions?: number | null;
  baselineAt?: string | null;
  baselineSessionCount?: number | null;
  status: 'active' | 'paused' | 'archived' | string;
  pausedAt?: string | null;
  nextDueAt?: string | null;
  nextDueSessionCount?: number | null;
  completedAt?: string | null;
  updatedAt?: string | null;
  dueStatus?: PlanState;
};

export type MaintenanceActivity = { id: string; planId?: string; action: string; occurredAt: string; note?: string | null };
export type PlanState = 'upcoming' | 'due' | 'overdue' | 'paused' | 'archived';

export type MaintenanceForm = {
  carId: string;
  componentId: string;
  name: string;
  calendarValue: string;
  calendarUnit: 'days' | 'weeks' | 'months';
  runInterval: string;
  baselineAt: string;
  baselineRuns: string;
};

type PlansResponse = { maintenancePlans?: MaintenancePlan[]; plans?: MaintenancePlan[]; activity?: MaintenanceActivity[] };
type ComponentsResponse = { components: MaintenanceComponent[] };
type PlanResponse = { maintenancePlan: MaintenancePlan };

const emptyForm = (): MaintenanceForm => ({ carId: '', componentId: '', name: '', calendarValue: '', calendarUnit: 'weeks', runInterval: '', baselineAt: '', baselineRuns: '0' });

export const calendarDays = (value: number, unit: MaintenanceForm['calendarUnit']): number => unit === 'weeks' ? value * 7 : unit === 'months' ? value * 30 : value;

export const calculatePlanState = (plan: MaintenancePlan, now = new Date(), sessionCount = 0): PlanState => {
  if (plan.dueStatus) return plan.dueStatus;
  if (plan.status === 'archived') return 'archived';
  if (plan.status === 'paused') return 'paused';
  const baseline = plan.baselineAt ? new Date(plan.baselineAt).getTime() : Number.POSITIVE_INFINITY;
  const calendarDue = plan.intervalDays ? now.getTime() >= baseline + plan.intervalDays * 86400000 : false;
  const runsDue = plan.intervalSessions ? sessionCount >= (plan.baselineSessionCount ?? 0) + plan.intervalSessions : false;
  if (calendarDue || runsDue) {
    const overdue = plan.nextDueAt ? now.getTime() > new Date(plan.nextDueAt).getTime() : calendarDue && now.getTime() > baseline + plan.intervalDays! * 86400000;
    return overdue ? 'overdue' : 'due';
  }
  return 'upcoming';
};

@Component({
  selector: 'app-maintenance-cockpit',
  standalone: true,
  imports: [CommonModule, DatePipe, FormsModule],
  templateUrl: './maintenance-cockpit.html',
  styleUrl: './maintenance-cockpit.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class MaintenanceCockpit {
  private readonly http = inject(HttpClient);
  @Input() set cars(value: MaintenanceCar[]) {
    const wasEmpty = this.garage().length === 0;
    this.garage.set(value);
    if (!value.length) return;
    if (!this.loaded() || (wasEmpty && value.length > 0)) this.load();
  }
  @Input() timezone = 'UTC';

  protected readonly garage = signal<MaintenanceCar[]>([]);
  protected readonly plans = signal<MaintenancePlan[]>([]);
  protected readonly activity = signal<MaintenanceActivity[]>([]);
  protected readonly components = signal<MaintenanceComponent[]>([]);
  protected readonly state = signal<'idle' | 'loading' | 'ready' | 'unavailable' | 'error'>('idle');
  protected readonly error = signal('');
  protected readonly loaded = signal(false);
  protected readonly editing = signal(false);
  protected readonly editingId = signal<string | null>(null);
  protected readonly action = signal<string | null>(null);
  protected readonly formError = signal('');
  protected readonly form = signal<MaintenanceForm>(emptyForm());
  protected readonly selectedFilter = signal<'all' | PlanState>('all');
  protected readonly visiblePlans = computed(() => this.plans().filter((plan) => this.selectedFilter() === 'all' || calculatePlanState(plan) === this.selectedFilter()));
  protected readonly grouped = computed(() => ({
    overdue: this.plans().filter((plan) => calculatePlanState(plan) === 'overdue'),
    due: this.plans().filter((plan) => calculatePlanState(plan) === 'due'),
    upcoming: this.plans().filter((plan) => calculatePlanState(plan) === 'upcoming'),
  }));
  protected readonly activeCount = computed(() => this.plans().filter((plan) => plan.status === 'active').length);

  protected load(): void {
    if (!this.garage().length) { this.state.set('ready'); this.loaded.set(true); return; }
    this.state.set('loading'); this.error.set('');
    this.http.get<PlansResponse>('/api/v1/maintenance-plans', { withCredentials: true }).subscribe({
      next: (response) => { this.plans.set(response.maintenancePlans ?? response.plans ?? []); this.activity.set(response.activity ?? []); this.state.set('ready'); this.loaded.set(true); },
      error: (error: { status?: number }) => { this.loaded.set(true); this.state.set(error.status === 404 ? 'unavailable' : 'error'); this.error.set(error.status === 401 ? 'Your garage session has expired. Sign in again to continue.' : 'Maintenance plans could not be loaded.'); },
    });
  }

  protected openCreate(): void {
    const firstCar = this.garage().find((car) => !car.archivedAt);
    this.form.set({ ...emptyForm(), carId: firstCar?.id ?? '', baselineAt: this.localDateTime(new Date()) });
    this.editingId.set(null); this.formError.set(''); this.loadComponents(this.form().carId); this.editing.set(true);
  }

  protected openEdit(plan: MaintenancePlan): void {
    if (this.isReadOnly(plan)) return;
    this.form.set({ ...emptyForm(), carId: plan.carId, componentId: plan.componentId, name: plan.name, calendarValue: plan.intervalValue ? String(plan.intervalValue) : plan.intervalDays ? String(plan.intervalDays) : '', calendarUnit: plan.intervalUnit ?? 'days', runInterval: plan.intervalSessions ? String(plan.intervalSessions) : '', baselineAt: plan.baselineAt ? this.localDateTime(new Date(plan.baselineAt)) : '', baselineRuns: String(plan.baselineSessionCount ?? 0) });
    this.editingId.set(plan.id); this.formError.set(''); this.loadComponents(plan.carId); this.editing.set(true);
  }

  protected cancelEdit(): void { this.editing.set(false); this.editingId.set(null); this.formError.set(''); }
  protected update(field: keyof MaintenanceForm, value: string): void { this.form.update((current) => ({ ...current, [field]: value })); if (field === 'carId') this.loadComponents(value); }
  protected setFilter(value: 'all' | PlanState): void { this.selectedFilter.set(value); }

  protected save(): void {
    const form = this.form();
    const calendar = form.calendarValue.trim() ? Number(form.calendarValue) : null;
    const runs = form.runInterval.trim() ? Number(form.runInterval) : null;
    if (!form.carId || !form.componentId || !form.name.trim()) { this.formError.set('Choose an installed component and name the care rule.'); return; }
    if (calendar !== null && (!Number.isInteger(calendar) || calendar < 1) || runs !== null && (!Number.isInteger(runs) || runs < 1)) { this.formError.set('Intervals must be whole numbers greater than zero.'); return; }
    if (calendar === null && runs === null) { this.formError.set('Add a calendar interval, a run threshold, or both.'); return; }
    if (this.action()) return;
    const payload = { carId: form.carId, componentId: form.componentId, name: form.name.trim(), intervalUnit: calendar === null ? undefined : form.calendarUnit, intervalValue: calendar === null ? undefined : calendar, intervalDays: calendar !== null && form.calendarUnit === 'days' ? calendar : undefined, intervalSessions: runs === null ? undefined : runs, baselineAt: form.baselineAt ? this.toIso(form.baselineAt) : undefined, baselineSessionCount: Number(form.baselineRuns) || 0 };
    const id = this.editingId(); this.action.set(id ? 'edit' : 'create'); this.formError.set('');
    const request = id ? this.http.patch<PlanResponse>(`/api/v1/maintenance-plans/${id}`, payload, { withCredentials: true }) : this.http.post<PlanResponse>('/api/v1/maintenance-plans', payload, { withCredentials: true });
    request.subscribe({ next: ({ maintenancePlan }) => { this.plans.update((plans) => id ? plans.map((plan) => plan.id === id ? maintenancePlan : plan) : [maintenancePlan, ...plans]); this.cancelEdit(); this.action.set(null); }, error: (error: { status?: number }) => { this.action.set(null); this.formError.set(error.status === 401 ? 'Your garage session has expired. Sign in again to continue.' : error.status === 409 ? 'This car is archived. Restore it before changing maintenance.' : 'The maintenance plan could not be saved.'); } });
  }

  protected transition(plan: MaintenancePlan, action: 'pause' | 'resume' | 'complete' | 'archive'): void {
    if (this.isReadOnly(plan)) return;
    this.action.set(`${action}:${plan.id}`);
    const request = action === 'archive' ? this.http.post<PlanResponse>(`/api/v1/maintenance-plans/${plan.id}/archive`, {}, { withCredentials: true }) : action === 'complete' ? this.http.post<PlanResponse>(`/api/v1/maintenance-plans/${plan.id}/complete`, { performedAt: new Date().toISOString() }, { withCredentials: true }) : this.http.post<PlanResponse>(`/api/v1/maintenance-plans/${plan.id}/${action}`, {}, { withCredentials: true });
    request.subscribe({ next: ({ maintenancePlan }) => { this.plans.update((plans) => plans.map((item) => item.id === plan.id ? maintenancePlan : item)); this.action.set(null); }, error: () => { this.action.set(null); this.error.set('That maintenance update could not be saved.'); } });
  }

  protected carName(carId: string): string { return this.garage().find((car) => car.id === carId)?.name ?? 'Unknown car'; }
  protected componentName(componentId: string): string { return this.components().find((component) => component.id === componentId)?.name ?? 'Installed component'; }
  protected planState(plan: MaintenancePlan): PlanState { return calculatePlanState(plan); }
  protected isReadOnly(plan: MaintenancePlan): boolean { return Boolean(this.garage().find((car) => car.id === plan.carId)?.archivedAt) || plan.status === 'archived'; }
  protected stateLabel(value: PlanState): string { return value === 'upcoming' ? 'Upcoming' : value[0].toUpperCase() + value.slice(1); }
  protected dueText(plan: MaintenancePlan): string { const state = this.planState(plan); return state === 'overdue' ? 'Needs attention' : state === 'due' ? 'Due now' : state === 'paused' ? 'Paused' : state === 'archived' ? 'Archived' : plan.nextDueAt ? `Due ${new Date(plan.nextDueAt).toLocaleDateString('en-US', { timeZone: this.timezone, month: 'short', day: 'numeric' })}` : 'Baseline set'; }
  protected localDateTime(date: Date): string { const parts = new Intl.DateTimeFormat('en-CA', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date); const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''; return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`; }
  private toIso(value: string): string {
    const [date, time] = value.split('T');
    if (!date || !time) return '';
    const [year, month, day] = date.split('-').map(Number);
    const [hour, minute] = time.split(':').map(Number);
    const asUtc = Date.UTC(year, month - 1, day, hour, minute);
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: this.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(asUtc));
    const get = (type: string) => Number(parts.find((part) => part.type === type)?.value);
    const offset = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute')) - asUtc;
    return new Date(asUtc - offset).toISOString();
  }
  private loadComponents(carId: string): void { if (!carId) return; this.http.get<ComponentsResponse>(`/api/v1/cars/${carId}/components`, { withCredentials: true }).subscribe({ next: ({ components }) => this.components.set(components.filter((component) => !component.removedAt)), error: () => this.components.set([]) }); }
}
