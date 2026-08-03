import { HttpClient } from '@angular/common/http';
import { DatePipe } from '@angular/common';
import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';

type Car = {
  id: string;
  name: string;
  manufacturer?: string | null;
  make?: string | null;
  model?: string | null;
  scale?: string | null;
  vehicleType?: string | null;
  powerType?: string | null;
  notes?: string | null;
  createdAt?: string;
  updatedAt?: string;
  archivedAt?: string | null;
};

type CarForm = {
  name: string;
  make: string;
  model: string;
  scale: string;
  vehicleType: string;
  powerType: string;
  notes: string;
};

type CarsResponse = { cars: Car[] };
type CarResponse = { car: Car };
type SessionResponse = { session?: unknown; user?: { email?: string } } | null;
type ViewState = 'checking' | 'signed-out' | 'signed-in';
type PasskeyState = 'loading' | 'ready' | 'error';
type CarState = 'loading' | 'ready' | 'error';
type CarView = 'list' | 'detail';
type ComponentState = 'idle' | 'loading' | 'ready' | 'error';
type ComponentMode = 'add' | 'edit' | 'replace';

type Passkey = {
  id: string;
  name?: string | null;
  createdAt?: string;
  aaguid?: string | null;
};

type InstalledComponent = {
  id: string;
  carId: string;
  slot: string;
  slotType?: 'standard' | 'custom' | null;
  name: string;
  manufacturer?: string | null;
  model?: string | null;
  serialNumber?: string | null;
  notes?: string | null;
  installedAt?: string;
  removedAt?: string | null;
};

type ComponentForm = {
  slotType: 'standard' | 'custom';
  slot: string;
  name: string;
  manufacturer: string;
  model: string;
  serialNumber: string;
  notes: string;
};

type ComponentsResponse = { components: InstalledComponent[] };

const standardComponentSlots = [
  'motor', 'esc', 'battery', 'steering-servo', 'throttle-servo', 'receiver',
  'gyro', 'transmitter', 'tires', 'wheels', 'shocks', 'front-differential',
  'center-differential', 'rear-differential', 'slipper-clutch', 'pinion-gear',
  'spur-gear', 'body', 'wing',
];

const emptyComponentForm = (): ComponentForm => ({ slotType: 'standard', slot: 'motor', name: '', manufacturer: '', model: '', serialNumber: '', notes: '' });

const componentFormFrom = (component: InstalledComponent): ComponentForm => ({
  slotType: component.slotType ?? (standardComponentSlots.includes(component.slot as never) ? 'standard' : 'custom'),
  slot: component.slot,
  name: component.name,
  manufacturer: component.manufacturer ?? '',
  model: component.model ?? '',
  serialNumber: component.serialNumber ?? '',
  notes: component.notes ?? '',
});

const componentPayload = (form: ComponentForm): Record<string, string> => ({
  slotType: form.slotType,
  slot: form.slot.trim(),
  name: form.name.trim(),
  manufacturer: form.manufacturer.trim(),
  model: form.model.trim(),
  serialNumber: form.serialNumber.trim(),
  notes: form.notes.trim(),
});

const componentDetailsPayload = (form: ComponentForm): Record<string, string> => ({
  name: form.name.trim(), manufacturer: form.manufacturer.trim(), model: form.model.trim(),
  serialNumber: form.serialNumber.trim(), notes: form.notes.trim(),
});

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

const emptyCarForm = (): CarForm => ({
  name: '', make: '', model: '', scale: '', vehicleType: '', powerType: '', notes: '',
});

const carFormFrom = (car: Car): CarForm => ({
  name: car.name,
  make: car.make ?? car.manufacturer ?? '',
  model: car.model ?? '',
  scale: car.scale ?? '',
  vehicleType: car.vehicleType ?? '',
  powerType: car.powerType ?? '',
  notes: car.notes ?? '',
});

const carPayload = (form: CarForm): Record<string, string> => {
  const payload: Record<string, string> = { name: form.name.trim() };
  const values: Array<[string, string]> = [
    ['make', form.make], ['model', form.model], ['scale', form.scale],
    ['vehicleType', form.vehicleType], ['powerType', form.powerType], ['notes', form.notes],
  ];
  for (const [key, value] of values) {
    payload[key] = value.trim();
  }
  return payload;
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
  protected readonly cars = signal<Car[]>([]);
  protected readonly carState = signal<CarState>('loading');
  protected readonly carError = signal('');
  protected readonly showArchived = signal(false);
  protected readonly selectedCarId = signal<string | null>(null);
  protected readonly carView = signal<CarView>('list');
  protected readonly carEditing = signal(false);
  protected readonly carAction = signal<string | null>(null);
  protected readonly carForm = signal<CarForm>(emptyCarForm());
  protected readonly carFormError = signal('');
  protected readonly components = signal<InstalledComponent[]>([]);
  protected readonly componentState = signal<ComponentState>('idle');
  protected readonly componentError = signal('');
  protected readonly componentMode = signal<ComponentMode>('add');
  protected readonly componentEditing = signal(false);
  protected readonly componentAction = signal<string | null>(null);
  protected readonly componentForm = signal<ComponentForm>(emptyComponentForm());
  protected readonly componentFormError = signal('');
  protected readonly editingComponentId = signal<string | null>(null);
  protected readonly standardComponentSlots = standardComponentSlots;
  protected readonly componentSlots = computed(() => {
    const slots = new Set(standardComponentSlots);
    this.components().forEach((component) => slots.add(component.slot));
    return [...slots];
  });
  protected readonly componentGroups = computed(() => this.componentSlots().map((slot) => {
    const history = this.components().filter((component) => component.slot === slot)
      .sort((left, right) => (right.installedAt ?? '').localeCompare(left.installedAt ?? ''));
    return {
      slot,
      current: history.find((component) => !component.removedAt) ?? null,
      history: history.filter((component) => Boolean(component.removedAt)),
    };
  }));
  protected readonly hasComponentHistory = computed(() => this.componentGroups().some((group) => Boolean(group.current) || group.history.length > 0));
  protected readonly visibleCars = computed(() => this.cars().filter((car) =>
    this.showArchived() ? Boolean(car.archivedAt) : !car.archivedAt));
  protected readonly selectedCar = computed(() => this.cars().find((car) => car.id === this.selectedCarId()) ?? null);
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
    this.carState.set('loading');
    this.carError.set('');
    const options = this.showArchived()
      ? { withCredentials: true, params: { archived: 'all' } }
      : { withCredentials: true };
    this.http.get<CarsResponse>('/api/v1/cars', options).subscribe({
      next: ({ cars }) => {
        this.cars.set(cars);
        this.activeCars.set(String(cars.filter((car) => !car.archivedAt).length));
        this.carState.set('ready');
      },
      error: (error: { status?: number }) => {
        this.carState.set('error');
        this.activeCars.set('—');
        this.carError.set(error.status === 401
          ? 'Your garage session has expired. Sign in again to continue.'
          : 'The garage could not be loaded. Check the connection and try again.');
        if (error.status === 401) this.state.set('signed-out');
      },
    });
  }

  protected retryCars(): void { this.loadCars(); }

  protected toggleArchived(): void {
    this.showArchived.update((value) => !value);
    this.selectedCarId.set(null);
    this.carView.set('list');
    this.carEditing.set(false);
    this.loadCars();
  }

  protected openCreateCar(): void {
    this.selectedCarId.set(null);
    this.carForm.set(emptyCarForm());
    this.carFormError.set('');
    this.carEditing.set(true);
    this.carView.set('detail');
  }

  protected openCar(car: Car): void {
    this.selectedCarId.set(car.id);
    this.carFormError.set('');
    this.carEditing.set(false);
    this.carView.set('detail');
    this.loadComponents(car.id);
  }

  protected editCar(): void {
    const car = this.selectedCar();
    if (!car) return;
    this.carForm.set(carFormFrom(car));
    this.carFormError.set('');
    this.carEditing.set(true);
  }

  protected cancelCarEdit(): void {
    this.carFormError.set('');
    this.carEditing.set(false);
  }

  protected backToGarage(): void {
    this.selectedCarId.set(null);
    this.carEditing.set(false);
    this.carView.set('list');
  }

  protected retryComponents(): void {
    const car = this.selectedCar();
    if (car) this.loadComponents(car.id);
  }

  protected openAddComponent(slot = ''): void {
    const car = this.selectedCar();
    if (!car || car.archivedAt) return;
    this.componentMode.set('add');
    this.editingComponentId.set(null);
    this.componentForm.set({ ...emptyComponentForm(), slot: slot || 'motor', slotType: slot && !standardComponentSlots.includes(slot as never) ? 'custom' : 'standard' });
    this.componentFormError.set('');
    this.componentEditing.set(true);
  }

  protected openEditComponent(component: InstalledComponent): void {
    const car = this.selectedCar();
    if (!car || car.archivedAt) return;
    this.componentMode.set('edit');
    this.editingComponentId.set(component.id);
    this.componentForm.set(componentFormFrom(component));
    this.componentFormError.set('');
    this.componentEditing.set(true);
  }

  protected openReplaceComponent(component: InstalledComponent): void {
    const car = this.selectedCar();
    if (!car || car.archivedAt) return;
    this.componentMode.set('replace');
    this.editingComponentId.set(component.id);
    this.componentForm.set({ ...emptyComponentForm(), slotType: component.slotType ?? 'custom', slot: component.slot });
    this.componentFormError.set('');
    this.componentEditing.set(true);
  }

  protected cancelComponentEdit(): void {
    this.componentEditing.set(false);
    this.editingComponentId.set(null);
    this.componentFormError.set('');
  }

  protected updateComponentField(field: keyof ComponentForm, value: string): void {
    this.componentForm.update((form) => ({ ...form, [field]: value }));
  }

  protected saveComponent(): void {
    const car = this.selectedCar();
    const form = this.componentForm();
    if (!car) return;
    if (car.archivedAt) {
      this.componentFormError.set('This car is archived. Restore it before recording component work.');
      return;
    }
    if (!form.slot.trim() || !form.name.trim()) {
      this.componentFormError.set('Choose a slot and describe the component before saving.');
      return;
    }
    if (this.componentAction()) return;
    const mode = this.componentMode();
    const componentId = this.editingComponentId();
    this.componentAction.set(mode);
    this.componentFormError.set('');
    const request = mode === 'edit' && componentId
      ? this.http.patch<{ component: InstalledComponent }>(`/api/v1/cars/${car.id}/components/${componentId}`, componentDetailsPayload(form), { withCredentials: true })
      : mode === 'replace' && componentId
        ? this.http.post<{ component: InstalledComponent }>(`/api/v1/cars/${car.id}/components/${componentId}/replace`, componentPayload(form), { withCredentials: true })
        : this.http.post<{ component: InstalledComponent }>(`/api/v1/cars/${car.id}/components`, componentPayload(form), { withCredentials: true });
    request.subscribe({
      next: () => {
        this.componentEditing.set(false);
        this.editingComponentId.set(null);
        this.componentAction.set(null);
        this.message.set(mode === 'replace'
          ? `${form.slot} replaced. The previous installation remains in the build history.`
          : mode === 'edit' ? `${form.slot} details saved.` : `${form.slot} added to the build sheet.`);
        this.loadComponents(car.id);
      },
      error: (error: { status?: number }) => {
        this.componentAction.set(null);
        this.componentFormError.set(error.status === 401
          ? 'Your garage session has expired. Sign in again to continue.'
          : error.status === 409
            ? 'This car is archived. Restore it before recording component work.'
            : 'The component could not be saved. Check the details and try again.');
        if (error.status === 401) this.state.set('signed-out');
      },
    });
  }

  protected updateCarField(field: keyof CarForm, value: string): void {
    this.carForm.update((form) => ({ ...form, [field]: value }));
  }

  private loadComponents(carId: string): void {
    this.componentState.set('loading');
    this.componentError.set('');
    this.http.get<ComponentsResponse>(`/api/v1/cars/${carId}/components`, {
      withCredentials: true, params: { history: 'true' },
    }).subscribe({
      next: ({ components }) => {
        this.components.set(components);
        this.componentState.set('ready');
      },
      error: (error: { status?: number }) => {
        this.componentState.set('error');
        this.componentError.set(error.status === 401
          ? 'Your garage session has expired. Sign in again to continue.'
          : 'The build sheet could not be loaded. Check the connection and try again.');
        if (error.status === 401) this.state.set('signed-out');
      },
    });
  }

  protected saveCar(): void {
    const form = this.carForm();
    if (!form.name.trim()) {
      this.carFormError.set('Give this car a name before saving.');
      return;
    }
    if (this.carAction()) return;
    this.carAction.set(this.selectedCarId() ? 'save' : 'create');
    this.carFormError.set('');
    const id = this.selectedCarId();
    const request = id
      ? this.http.patch<CarResponse>(`/api/v1/cars/${id}`, carPayload(form), { withCredentials: true })
      : this.http.post<CarResponse>('/api/v1/cars', carPayload(form), { withCredentials: true });
    request.subscribe({
      next: ({ car }) => {
        this.selectedCarId.set(car.id);
        this.carEditing.set(false);
        this.carView.set('detail');
        this.carAction.set(null);
        this.message.set(id ? 'Car details saved.' : 'Car added to the garage.');
        this.loadCars();
      },
      error: (error: { status?: number }) => {
        this.carAction.set(null);
        this.carFormError.set(error.status === 401
          ? 'Your garage session has expired. Sign in again to continue.'
          : 'The car could not be saved. Check the details and try again.');
        if (error.status === 401) this.state.set('signed-out');
      },
    });
  }

  protected archiveCar(): void { this.changeCarArchiveState('archive'); }

  protected restoreCar(): void { this.changeCarArchiveState('restore'); }

  private changeCarArchiveState(action: 'archive' | 'restore'): void {
    const car = this.selectedCar();
    if (!car || this.carAction()) return;
    this.carAction.set(action);
    this.message.set('');
    this.http.post<CarResponse>(`/api/v1/cars/${car.id}/${action}`, {}, { withCredentials: true }).subscribe({
      next: ({ car: updated }) => {
        this.cars.update((cars) => cars.map((item) => item.id === updated.id ? updated : item));
        this.selectedCarId.set(updated.id);
        this.carAction.set(null);
        this.message.set(action === 'archive' ? 'Car archived. Its history is still available.' : 'Car restored to the active garage.');
        if (action === 'archive') this.showArchived.set(true);
        this.loadCars();
      },
      error: (error: { status?: number }) => {
        this.carAction.set(null);
        this.carError.set(error.status === 404
          ? 'That car is no longer available.'
          : 'The car lifecycle change could not be saved. Try again.');
        if (error.status === 401) this.state.set('signed-out');
      },
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
