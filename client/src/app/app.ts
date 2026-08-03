import { HttpClient } from '@angular/common/http';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';

type CarsResponse = { cars: unknown[] };
type SessionResponse = { session?: unknown; user?: { email?: string } } | null;
type ViewState = 'checking' | 'signed-out' | 'signed-in';

@Component({
  selector: 'app-root',
  imports: [FormsModule],
  templateUrl: './app.html',
  styleUrl: './app.css',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class App {
  private readonly http = inject(HttpClient);

  protected readonly state = signal<ViewState>('checking');
  protected readonly email = signal('');
  protected readonly requestState = signal<'idle' | 'sending' | 'sent'>('idle');
  protected readonly message = signal('');
  protected readonly activeCars = signal('—');
  protected readonly ownerEmail = signal('');

  constructor() {
    this.consumeMagicLinkError();
    this.loadSession();
  }

  protected requestMagicLink(): void {
    const email = this.email().trim();
    if (!email || this.requestState() === 'sending') return;

    this.requestState.set('sending');
    this.message.set('');
    this.http.post('/api/auth/sign-in/magic-link', {
      email,
      callbackURL: window.location.origin,
    }, { withCredentials: true }).subscribe({
      next: () => {
        this.requestState.set('sent');
        this.message.set('If that address is allowed, a sign-in link is on its way.');
      },
      error: () => {
        this.requestState.set('idle');
        this.message.set('That request could not be completed. Check the address and try again.');
      },
    });
  }

  protected signOut(): void {
    this.message.set('');
    this.http.post('/api/auth/sign-out', {}, { withCredentials: true }).subscribe({
      next: () => {
        this.state.set('signed-out');
        this.ownerEmail.set('');
        this.activeCars.set('—');
      },
      error: () => this.message.set('We could not sign you out. Try again.'),
    });
  }

  protected retrySession(): void {
    this.loadSession();
  }

  private loadSession(): void {
    this.state.set('checking');
    this.http.get<SessionResponse>('/api/auth/get-session', { withCredentials: true }).subscribe({
      next: (response) => {
        if (!response?.session) {
          this.state.set('signed-out');
          return;
        }

        this.state.set('signed-in');
        this.ownerEmail.set(response.user?.email ?? 'Owner');
        this.loadCars();
      },
      error: () => {
        this.state.set('signed-out');
        if (!this.message()) this.message.set('We could not check the garage session. Try again.');
      },
    });
  }

  private consumeMagicLinkError(): void {
    const url = new URL(window.location.href);
    const errorParameters = ['error', 'error_description', 'error_code', 'errorCode'];
    if (!errorParameters.some((parameter) => url.searchParams.has(parameter))) return;

    this.message.set('That recovery link could not be used. Request a new magic link and try again.');
    errorParameters.forEach((parameter) => url.searchParams.delete(parameter));
    const query = url.searchParams.toString();
    window.history.replaceState(window.history.state, document.title, `${url.pathname}${query ? `?${query}` : ''}${url.hash}`);
  }

  private loadCars(): void {
    this.http.get<CarsResponse>('/api/v1/cars', { withCredentials: true }).subscribe({
      next: ({ cars }) => this.activeCars.set(String(cars.length)),
      error: () => this.activeCars.set('—'),
    });
  }
}
