import { Component, signal } from '@angular/core';

@Component({
  selector: 'app-root',
  templateUrl: './app.html',
  styleUrl: './app.css',
})
export class App {
  protected readonly activeCars = signal('—');

  constructor() {
    void fetch('/api/v1/cars', { credentials: 'include' })
      .then((response) => (response.ok ? response.json() : { cars: [] }))
      .then((data: { cars?: unknown[] }) => this.activeCars.set(String(data.cars?.length ?? 0)))
      .catch(() => undefined);
  }
}
