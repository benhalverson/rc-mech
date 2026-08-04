import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { provideHttpClient } from '@angular/common/http';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { MaintenanceCockpit, MaintenancePlan, calculatePlanState, calendarDays } from './maintenance-cockpit';

describe('MaintenanceCockpit', () => {
  let fixture: ComponentFixture<MaintenanceCockpit>;
  let http: HttpTestingController;
  const car = { id: 'car-1', name: 'Red Runner', archivedAt: null };
  const component = { id: 'component-1', carId: 'car-1', slot: 'motor', name: 'Race motor' };
  const plan: MaintenancePlan = { id: 'plan-1', carId: 'car-1', componentId: 'component-1', name: 'Clean bearings', intervalDays: 30, intervalSessions: 5, baselineAt: '2026-07-01T00:00:00.000Z', baselineSessionCount: 0, status: 'active' };

  beforeEach(async () => {
    await TestBed.configureTestingModule({ imports: [MaintenanceCockpit], providers: [provideHttpClient(), provideHttpClientTesting()] }).compileComponents();
    http = TestBed.inject(HttpTestingController);
    fixture = TestBed.createComponent(MaintenanceCockpit);
    fixture.componentRef.setInput('cars', [car]);
    fixture.componentRef.setInput('timezone', 'America/Los_Angeles');
    http.expectOne('/api/v1/maintenance-plans').flush({ maintenancePlans: [plan], activity: [] });
    http.expectOne((request) => request.url === '/api/v1/cars/car-1/service-records' && request.params.get('history') === 'true').flush({ serviceRecords: [] });
    fixture.detectChanges();
  });

  afterEach(() => http.verify());

  it('groups date, run, combined, timezone, and lifecycle states', () => {
    expect(calendarDays(2, 'weeks')).toBe(14);
    expect(calendarDays(1, 'months')).toBe(30);
    expect(calculatePlanState({ ...plan, intervalSessions: null }, new Date('2026-07-15T00:00:00.000Z'))).toBe('upcoming');
    expect(calculatePlanState({ ...plan, intervalDays: null }, new Date('2026-07-02T00:00:00.000Z'), 5)).toBe('due');
    expect(calculatePlanState(plan, new Date('2026-08-02T00:00:00.000Z'))).toBe('overdue');
    expect(calculatePlanState({ ...plan, status: 'paused' })).toBe('paused');
    expect(calculatePlanState({ ...plan, status: 'archived' })).toBe('archived');
  });

  it('creates a plan through the existing relative maintenance endpoint', () => {
    const app = fixture.componentInstance as any;
    app.openCreate();
    http.expectOne('/api/v1/cars/car-1/components').flush({ components: [component] });
    app.form.set({ carId: 'car-1', componentId: 'component-1', name: 'Clean bearings', calendarValue: '2', calendarUnit: 'weeks', runInterval: '5', baselineAt: '2026-08-01T10:00', baselineRuns: '3' });
    app.save();
    const request = http.expectOne('/api/v1/maintenance-plans');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toMatchObject({ carId: 'car-1', componentId: 'component-1', intervalUnit: 'weeks', intervalValue: 2, intervalSessions: 5, baselineSessionCount: 3 });
    request.flush({ maintenancePlan: { ...plan, name: 'Clean bearings', intervalDays: 14 } });
    fixture.detectChanges();
    expect(fixture.nativeElement.textContent).toContain('Clean bearings');
  });

  it('records ad hoc service with cost data through the car-scoped route', () => {
    const app = fixture.componentInstance as any;
    app.openServiceCreate();
    http.expectOne('/api/v1/cars/car-1/components').flush({ components: [component] });
    app.serviceForm.set({ carId: 'car-1', componentId: 'component-1', performedAt: '2026-08-02T10:00', description: 'Rebuilt the front diff', cost: '24.5', currency: 'usd' });
    app.saveService();
    const request = http.expectOne('/api/v1/cars/car-1/service-records');
    expect(request.request.method).toBe('POST');
    expect(request.request.withCredentials).toBe(true);
    expect(request.request.body).toMatchObject({ description: 'Rebuilt the front diff', cost: 24.5, currency: 'USD' });
    request.flush({ serviceRecord: { id: 'record-1', carId: 'car-1', performedAt: '2026-08-02T17:00:00.000Z', description: 'Rebuilt the front diff', cost: 24.5, currency: 'USD' } });
    expect(app.serviceRecords()[0].id).toBe('record-1');
  });

  it('completes a plan from the service form and sends notes and cost', () => {
    const app = fixture.componentInstance as any;
    app.openCompletion(plan);
    http.expectOne('/api/v1/cars/car-1/components').flush({ components: [component] });
    app.serviceForm.update((form: any) => ({ ...form, description: 'Cleaned bearings', cost: '8', currency: 'CAD' }));
    app.saveService();
    const request = http.expectOne('/api/v1/maintenance-plans/plan-1/complete');
    expect(request.request.body).toMatchObject({ description: 'Cleaned bearings', cost: 8, currency: 'CAD' });
    request.flush({ serviceRecord: { id: 'record-2', planId: 'plan-1', carId: 'car-1', performedAt: '2026-08-02T17:00:00.000Z', description: 'Cleaned bearings', cost: 8, currency: 'CAD' }, maintenancePlan: { ...plan, baselineAt: '2026-08-02T17:00:00.000Z' } });
    expect(app.plans()[0].baselineAt).toBe('2026-08-02T17:00:00.000Z');
  });

  it('soft-deletes a record and can undo the correction', () => {
    const app = fixture.componentInstance as any;
    const record = { id: 'record-3', carId: 'car-1', performedAt: '2026-08-02T00:00:00.000Z', description: 'Checked tires' };
    app.serviceRecords.set([record]);
    app.deleteService(record);
    const deletion = http.expectOne('/api/v1/service-records/record-3');
    expect(deletion.request.method).toBe('DELETE');
    deletion.flush({ serviceRecord: { ...record, deletedAt: '2026-08-03T00:00:00.000Z' } });
    app.restoreService({ ...record, deletedAt: '2026-08-03T00:00:00.000Z' });
    const restore = http.expectOne('/api/v1/service-records/record-3/restore');
    expect(restore.request.method).toBe('POST');
    restore.flush({ serviceRecord: record });
    expect(app.serviceRecords()[0].deletedAt).toBeUndefined();
  });

  it('does not show a mixed-currency total in the history header', () => {
    const app = fixture.componentInstance as any;
    app.serviceRecords.set([
      { id: 'record-1', carId: 'car-1', performedAt: '2026-08-02T17:00:00.000Z', description: 'Rebuilt diff', cost: 24.5, currency: 'USD' },
      { id: 'record-2', carId: 'car-1', performedAt: '2026-08-03T17:00:00.000Z', description: 'Changed shocks', cost: 8, currency: 'CAD' },
    ]);
    fixture.detectChanges();
    const historyTotal = fixture.nativeElement.querySelector('.history-total')?.textContent ?? '';
    expect(historyTotal).toContain('2 records');
    expect(historyTotal).not.toContain('logged');
    expect(historyTotal).not.toContain('32.50');
  });

  it('keeps archived-car plans read-only', () => {
    const app = fixture.componentInstance as any;
    app.garage.set([{ ...car, archivedAt: '2026-08-01T00:00:00.000Z' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.plan-actions .text-button')?.disabled).toBe(true);
  });
});
