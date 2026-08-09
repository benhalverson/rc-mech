import { HttpErrorResponse, httpResource } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { ShellRouteContext } from '../../shell/shell-route-context';
import {
	parseCurrentSetupCollection,
	type CurrentSetupCollection,
} from './current-setup.models';

export type CurrentSetupGatewayFailure =
	| { kind: 'http'; status: number }
	| { kind: 'unavailable' }
	| { kind: 'invalid-response' };

export const currentSetupGatewayFailure = (
	error: unknown,
): CurrentSetupGatewayFailure | null => {
	if (!error) return null;
	if (error instanceof HttpErrorResponse)
		return error.status === 0
			? { kind: 'unavailable' }
			: { kind: 'http', status: error.status };
	return error instanceof Error &&
		error.message.includes('response was invalid')
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Service()
export class CurrentSetupGateway {
	private readonly route = inject(ShellRouteContext);
	readonly collection = httpResource<CurrentSetupCollection>(
		() => {
			const carId = this.route.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/setups`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseCurrentSetupCollection },
	);

	failure(): CurrentSetupGatewayFailure | null {
		return currentSetupGatewayFailure(this.collection.error());
	}

	refresh(): void {
		this.collection.reload();
	}
}
