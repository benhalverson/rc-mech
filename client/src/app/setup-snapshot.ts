import { HttpClient } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Observable } from 'rxjs';

export const setupSectionKeys = [
	'vehicle',
	'drivetrain',
	'electronics',
	'tires',
	'shocks',
	'frontSuspension',
	'rearSuspension',
	'notes',
] as const;

export type SetupSectionKey = (typeof setupSectionKeys)[number];
export type SetupSectionValues = Record<string, string | null>;
export type SetupSections = Record<SetupSectionKey, SetupSectionValues>;

export type SetupSource = {
	url?: string | null;
	pdfUrl?: string | null;
	pdfTitle?: string | null;
	pdfPage?: number | null;
};

export type SetupContext = {
	recordedAt?: string | null;
	track?: string | null;
	event?: string | null;
	surface?: string | null;
	traction?: string | null;
	moisture?: string | null;
	condition?: string | null;
	temperature?: string | null;
};

export type SetupSnapshot = {
	id: string;
	carId: string;
	name: string;
	current?: boolean;
	context?: SetupContext | null;
	sections: SetupSections;
	source?: SetupSource | null;
	copiedFromSetupId?: string | null;
	unmappedValues?: Record<string, unknown> | null;
	createdAt?: string;
	updatedAt?: string;
};

export type SetupSnapshotPayload = Omit<
	SetupSnapshot,
	'id' | 'carId' | 'current' | 'createdAt' | 'updatedAt'
>;

type SetupsResponse = { setups: SetupSnapshot[] };
type SetupResponse = { setup: SetupSnapshot };

@Injectable({ providedIn: 'root' })
export class SetupSnapshotService {
	private readonly http = inject(HttpClient);

	list(carId: string): Observable<SetupsResponse> {
		return this.http.get<SetupsResponse>(
			`/api/v1/cars/${encodeURIComponent(carId)}/setups`,
			{ withCredentials: true },
		);
	}

	get(carId: string, setupId: string): Observable<SetupResponse> {
		return this.http.get<SetupResponse>(this.endpoint(carId, setupId), {
			withCredentials: true,
		});
	}

	create(
		carId: string,
		payload: SetupSnapshotPayload,
	): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			this.collectionEndpoint(carId),
			payload,
			{
				withCredentials: true,
			},
		);
	}

	update(
		carId: string,
		setupId: string,
		payload: SetupSnapshotPayload,
	): Observable<SetupResponse> {
		return this.http.patch<SetupResponse>(
			this.endpoint(carId, setupId),
			payload,
			{
				withCredentials: true,
			},
		);
	}

	copy(carId: string, setupId: string): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			`${this.endpoint(carId, setupId)}/copy`,
			{},
			{
				withCredentials: true,
			},
		);
	}

	selectCurrent(carId: string, setupId: string): Observable<SetupResponse> {
		return this.http.post<SetupResponse>(
			`${this.endpoint(carId, setupId)}/current`,
			{},
			{
				withCredentials: true,
			},
		);
	}

	private collectionEndpoint(carId: string): string {
		return `/api/v1/cars/${encodeURIComponent(carId)}/setups`;
	}

	private endpoint(carId: string, setupId: string): string {
		return `${this.collectionEndpoint(carId)}/${encodeURIComponent(setupId)}`;
	}
}
