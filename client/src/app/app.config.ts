import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
	ApplicationConfig,
	inject,
	provideBrowserGlobalErrorListeners,
	provideEnvironmentInitializer,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';

import { routes } from './app.routes';
import { AppearanceService } from './appearance.service';
import { ownerSessionExpiryInterceptor } from './owner-session-expiry.interceptor';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideEnvironmentInitializer(() => {
			inject(AppearanceService);
		}),
		provideHttpClient(withInterceptors([ownerSessionExpiryInterceptor])),
		provideRouter(routes, withComponentInputBinding()),
	],
};
