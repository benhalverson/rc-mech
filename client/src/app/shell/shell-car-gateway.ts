import { httpResource } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { array, minLength, nullable, object, optional, string } from 'zod/mini';
import { ShellRouteContext } from './shell-route-context';

const shellCarSchema = object({
	id: string().check(minLength(1)),
	name: string().check(minLength(1)),
	archivedAt: optional(nullable(string())),
});

const shellCarCollectionSchema = object({
	cars: array(shellCarSchema),
});

export type ShellCar = {
	id: string;
	name: string;
	archivedAt: string | null;
};

export type ShellCarCollection = { cars: ShellCar[] };

export const parseShellCarCollection = (value: unknown): ShellCarCollection => {
	const parsed = shellCarCollectionSchema.safeParse(value);
	if (!parsed.success) throw new Error('The shell car response was invalid.');
	return {
		cars: parsed.data.cars.map(({ id, name, archivedAt }) => ({
			id,
			name,
			archivedAt: archivedAt ?? null,
		})),
	};
};

@Service()
export class ShellCarGateway {
	private readonly route = inject(ShellRouteContext);
	readonly collection = httpResource<ShellCarCollection>(
		() =>
			this.route.carId()
				? {
						url: '/api/v1/cars',
						withCredentials: true,
						params: { archived: 'all' },
					}
				: undefined,
		{ parse: parseShellCarCollection },
	);

	refresh(): void {
		this.collection.reload();
	}
}
