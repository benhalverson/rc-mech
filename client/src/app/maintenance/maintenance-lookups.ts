import { HttpClient } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { map, type Observable } from 'rxjs';
import type { MaintenanceComponent } from './maintenance.models';

type ComponentsResponse = { components: MaintenanceComponent[] };
type SetupResponse = {
	setup?: { tires?: Record<string, unknown> | null };
	setups?: Array<{ current?: boolean; tires?: Record<string, unknown> | null }>;
};

@Service()
export class MaintenanceLookups {
	private readonly http = inject(HttpClient);

	components(carId: string): Observable<MaintenanceComponent[]> {
		return this.http
			.get<ComponentsResponse>(
				`/api/v1/cars/${encodeURIComponent(carId)}/components`,
				{
					withCredentials: true,
				},
			)
			.pipe(
				map(({ components }) =>
					components.filter((component) => !component.removedAt),
				),
			);
	}

	currentTires(carId: string): Observable<Record<string, unknown> | null> {
		return this.http
			.get<SetupResponse>(
				`/api/v1/cars/${encodeURIComponent(carId)}/setups/current`,
				{ withCredentials: true },
			)
			.pipe(
				map((response) => {
					const setup =
						response.setup ??
						response.setups?.find((item) => item.current) ??
						response.setups?.[0];
					return setup?.tires ?? null;
				}),
			);
	}
}
