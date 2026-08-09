import type { Routes } from '@angular/router';
import { AuthenticationGateway } from './authentication-gateway';
import { AuthenticationStore } from './authentication-store';
import { PasskeyCapability } from './passkey-capability';

export const SIGN_IN_ROUTES: Routes = [
	{
		path: '',
		providers: [AuthenticationGateway, AuthenticationStore, PasskeyCapability],
		loadComponent: () => import('./sign-in').then(({ SignIn }) => SignIn),
	},
];
