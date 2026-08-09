import { Routes } from '@angular/router';
import { ClipboardCapability } from './clipboard-capability';
import { InviteStore } from './invite-store';
import { PasskeyRegistrationCapability } from './passkey-registration-capability';
import { PasskeyStore } from './passkey-store';
import { SettingsGateway } from './settings-gateway';
import { TimezoneGateway } from './timezone-gateway';
import { TimezoneStore } from './timezone-store';

export const SETTINGS_ROUTES: Routes = [
	{
		path: '',
		providers: [
			ClipboardCapability,
			InviteStore,
			PasskeyRegistrationCapability,
			PasskeyStore,
			SettingsGateway,
			TimezoneGateway,
			TimezoneStore,
		],
		loadComponent: () => import('./settings').then(({ Settings }) => Settings),
	},
];
