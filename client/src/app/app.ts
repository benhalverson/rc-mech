import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

type CarsResponse = { cars: unknown[] };
type SessionResponse = { session?: unknown; user?: { email?: string } } | null;
type ViewState = 'checking' | 'signed-out' | 'signed-in';
type PasskeyState = 'loading' | 'ready' | 'error';

type Passkey = {
  id: string;
  name?: string | null;
  createdAt?: string;
  aaguid?: string | null;
};

type WebAuthnOptions = {
  challenge: string;
  user?: { id: string; name: string; displayName: string };
  excludeCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
  allowCredentials?: Array<{ id: string; type: 'public-key'; transports?: AuthenticatorTransport[] }>;
  [key: string]: unknown;
};

const base64UrlToBytes = (value: string): Uint8Array => {
  const normalized = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = window.atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
};

const bytesToBase64Url = (value: ArrayBuffer): string => {
  const bytes = new Uint8Array(value);
  let binary = '';
  bytes.forEach((byte) => binary += String.fromCharCode(byte));
  return window.btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const webAuthnError = (error: unknown): string => {
	if (error instanceof DOMException && error.name === 'NotAllowedError') return 'The passkey ceremony was cancelled or timed out.';
	if (error instanceof Error && 'status' in error) return 'The passkey request could not be completed. Try again or use a magic link.';
	if (error instanceof Error && error.message) return error.message;
  return 'The passkey request could not be completed. Try again or use a magic link.';
};

@Component({
  selector: 'app-root',
  imports: [DatePipe, FormsModule],
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
  protected readonly passkeys = signal<Passkey[]>([]);
  protected readonly passkeyState = signal<PasskeyState>('loading');
  protected readonly passkeyMessage = signal('');
  protected readonly newPasskeyName = signal('');
  protected readonly passkeyAction = signal<string | null>(null);
  protected readonly editingPasskey = signal<string | null>(null);
  protected readonly editedPasskeyName = signal('');
  protected readonly webAuthnAvailable = signal(typeof navigator !== 'undefined'
    && 'credentials' in navigator
    && typeof PublicKeyCredential !== 'undefined'
    && (window.isSecureContext || window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'));

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

  protected async signInWithPasskey(): Promise<void> {
    if (!this.webAuthnAvailable() || this.passkeyAction()) return;
    this.passkeyAction.set('sign-in');
    this.message.set('');
    try {
      const options = await firstValueFrom(this.http.get<WebAuthnOptions>('/api/auth/passkey/generate-authenticate-options'));
      const credential = await navigator.credentials.get({ publicKey: this.authenticationOptions(options) });
      if (!credential || typeof credential !== 'object' || !('response' in credential)) throw new Error('No passkey was returned by the browser.');
      await firstValueFrom(this.http.post('/api/auth/passkey/verify-authentication', {
        response: this.authenticationResponse(credential as PublicKeyCredential),
      }, { withCredentials: true }));
      this.loadSession();
    } catch (error) {
      this.message.set(webAuthnError(error));
    } finally {
      this.passkeyAction.set(null);
    }
  }

  protected async registerPasskey(): Promise<void> {
    const name = this.newPasskeyName().trim();
    if (!this.webAuthnAvailable() || !name || this.passkeyAction()) return;
    this.passkeyAction.set('register');
    this.passkeyMessage.set('');
    try {
      const options = await firstValueFrom(this.http.get<WebAuthnOptions>('/api/auth/passkey/generate-register-options', {
        params: { name }, withCredentials: true,
      }));
      const credential = await navigator.credentials.create({ publicKey: this.registrationOptions(options) });
      if (!credential || typeof credential !== 'object' || !('response' in credential)) throw new Error('No passkey was returned by the browser.');
      await firstValueFrom(this.http.post('/api/auth/passkey/verify-registration', {
        response: this.registrationResponse(credential as PublicKeyCredential), name,
      }, { withCredentials: true }));
      this.newPasskeyName.set('');
      this.passkeyMessage.set('Passkey added. Keep a second one registered for recovery from a lost device.');
      this.loadPasskeys();
    } catch (error) {
      this.passkeyMessage.set(webAuthnError(error));
    } finally {
      this.passkeyAction.set(null);
    }
  }

  protected beginRename(passkey: Passkey): void {
    this.editingPasskey.set(passkey.id);
    this.editedPasskeyName.set(passkey.name?.trim() || 'Passkey');
  }

  protected cancelRename(): void {
    this.editingPasskey.set(null);
    this.editedPasskeyName.set('');
  }

  protected async renamePasskey(passkey: Passkey): Promise<void> {
    const name = this.editedPasskeyName().trim();
    if (!name || this.passkeyAction()) return;
    this.passkeyAction.set(`rename:${passkey.id}`);
    this.passkeyMessage.set('');
    try {
      await firstValueFrom(this.http.post('/api/auth/passkey/update-passkey', { id: passkey.id, name }, { withCredentials: true }));
      this.cancelRename();
      this.passkeyMessage.set('Passkey renamed.');
      this.loadPasskeys();
    } catch (error) {
      this.passkeyMessage.set(webAuthnError(error));
    } finally {
      this.passkeyAction.set(null);
    }
  }

  protected async revokePasskey(passkey: Passkey): Promise<void> {
    if (this.passkeyAction()) return;
    this.passkeyAction.set(`revoke:${passkey.id}`);
    this.passkeyMessage.set('');
    try {
      await firstValueFrom(this.http.post('/api/auth/passkey/delete-passkey', { id: passkey.id }, { withCredentials: true }));
      this.passkeyMessage.set('Passkey revoked. Magic-link recovery remains available.');
      this.loadPasskeys();
    } catch (error) {
      this.passkeyMessage.set(webAuthnError(error));
    } finally {
      this.passkeyAction.set(null);
    }
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
        this.loadPasskeys();
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

  private loadPasskeys(): void {
    this.passkeyState.set('loading');
    this.http.get<Passkey[]>('/api/auth/passkey/list-user-passkeys', { withCredentials: true }).subscribe({
      next: (passkeys) => { this.passkeys.set(passkeys); this.passkeyState.set('ready'); },
      error: () => { this.passkeyState.set('error'); this.passkeyMessage.set('Passkeys could not be loaded. Try again.'); },
    });
  }

  private registrationOptions(options: WebAuthnOptions): PublicKeyCredentialCreationOptions {
    return {
      ...options,
      challenge: base64UrlToBytes(options.challenge),
      user: options.user ? { ...options.user, id: base64UrlToBytes(options.user.id) } : undefined,
      excludeCredentials: options.excludeCredentials?.map((item) => ({ ...item, id: base64UrlToBytes(item.id) })),
    } as unknown as PublicKeyCredentialCreationOptions;
  }

  private authenticationOptions(options: WebAuthnOptions): PublicKeyCredentialRequestOptions {
    return {
      ...options,
      challenge: base64UrlToBytes(options.challenge),
      allowCredentials: options.allowCredentials?.map((item) => ({ ...item, id: base64UrlToBytes(item.id) })),
    } as unknown as PublicKeyCredentialRequestOptions;
  }

  private registrationResponse(credential: PublicKeyCredential): Record<string, unknown> {
    const response = credential.response as AuthenticatorAttestationResponse;
    return {
      id: credential.id,
      rawId: bytesToBase64Url(credential.rawId),
      response: {
        clientDataJSON: bytesToBase64Url(response.clientDataJSON),
        attestationObject: bytesToBase64Url(response.attestationObject),
        transports: response.getTransports?.(),
      },
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }

  private authenticationResponse(credential: PublicKeyCredential): Record<string, unknown> {
    const response = credential.response as AuthenticatorAssertionResponse;
    return {
      id: credential.id,
      rawId: bytesToBase64Url(credential.rawId),
      response: {
        clientDataJSON: bytesToBase64Url(response.clientDataJSON),
        authenticatorData: bytesToBase64Url(response.authenticatorData),
        signature: bytesToBase64Url(response.signature),
        userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : undefined,
      },
      type: credential.type,
      clientExtensionResults: credential.getClientExtensionResults(),
    };
  }
}
