import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { catchError, map, of } from 'rxjs';

type CarsResponse = { cars: unknown[] };

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly http = inject(HttpClient);

  protected readonly activeCars = toSignal(
    this.http.get<CarsResponse>('/api/v1/cars', { withCredentials: true }).pipe(
      map(({ cars }) => String(cars.length)),
      catchError(() => of('0')),
    ),
    { initialValue: '—' },
  );
}
