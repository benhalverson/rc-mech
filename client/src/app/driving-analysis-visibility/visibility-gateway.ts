import { httpResource } from '@angular/common/http';
import { Service } from '@angular/core';
import { boolean, object } from 'zod/mini';

const flagSchema = object({ enabled: boolean() });
const ownerSchema = object({ isOwner: boolean() });

@Service()
export class VisibilityGateway {
	read() {
		// A fresh session must reach the server, including when an installed app is offline.
		const options = {
			withCredentials: true,
			timeout: 5000,
			cache: 'no-store' as const,
			headers: { 'ngsw-bypass': 'true' },
		};
		return {
			flag: httpResource(
				() => ({ ...options, url: '/api/v1/feature-flags/driving-analysis' }),
				{ parse: (value) => flagSchema.parse(value) },
			),
			owner: httpResource(
				() => ({ ...options, url: '/api/v1/feature-flags/owner' }),
				{ parse: (value) => ownerSchema.parse(value) },
			),
		};
	}
}
