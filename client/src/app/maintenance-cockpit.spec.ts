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

  it('keeps archived-car plans read-only', () => {
    const app = fixture.componentInstance as any;
    app.garage.set([{ ...car, archivedAt: '2026-08-01T00:00:00.000Z' }]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.plan-actions .text-button')?.disabled).toBe(true);
  });
});
