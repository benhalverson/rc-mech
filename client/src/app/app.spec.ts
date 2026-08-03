import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { TestBed } from '@angular/core/testing';
import { App } from './app';

describe('App', () => {
  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [App],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    }).compileComponents();
  });

  afterEach(() => TestBed.inject(HttpTestingController).verify());

  const createFixture = () => {
    const fixture = TestBed.createComponent(App);
    TestBed.inject(HttpTestingController).expectOne('/api/v1/cars').flush({ cars: [] });
    fixture.detectChanges();
    return fixture;
  };

  it('should create the app', () => {
    const fixture = createFixture();
    const app = fixture.componentInstance;
    expect(app).toBeTruthy();
  });

  it('should render the garage title', () => {
    const fixture = createFixture();
    const compiled = fixture.nativeElement as HTMLElement;
    expect(compiled.querySelector('h1')?.textContent).toContain('Garage control');
  });
});
