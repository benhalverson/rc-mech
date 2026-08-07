import { provideHttpClient, withInterceptors } from '@angular/common/http';
import {
	ApplicationConfig,
	provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideAnimations } from '@angular/platform-browser/animations';
import { provideRouter } from '@angular/router';

import { routes } from './app.routes';
import { ownerSessionExpiryInterceptor } from './owner-session-expiry.interceptor';

export const appConfig: ApplicationConfig = {
	providers: [
		provideBrowserGlobalErrorListeners(),
		provideHttpClient(withInterceptors([ownerSessionExpiryInterceptor])),
		provideRouter(routes),
		provideAnimations(),
	],
};
