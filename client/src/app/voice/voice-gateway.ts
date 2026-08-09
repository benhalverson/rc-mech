import {
	HttpClient,
	HttpErrorResponse,
	httpResource,
} from '@angular/common/http';
import { Injectable, inject, signal } from '@angular/core';
import { catchError, defer, map, type Observable, throwError } from 'rxjs';
import type * as z from 'zod/mini';
import { minLength, object, safeParse, string, trim } from 'zod/mini';
import type {
	PendingVoiceCapture,
	VoiceContextCar,
	VoiceGatewayFailure,
	VoiceMutationResponse,
	VoiceUpdate,
} from './voice.models';
import {
	voiceContextCarsSchema,
	voiceListSchema,
	voiceMutationSchema,
} from './voice.models';

const apiErrorSchema = object({
	error: string().check(trim(), minLength(1)),
});

class InvalidVoiceResponse extends Error {}

const parse = <T>(schema: z.core.$ZodType<T>, value: unknown): T => {
	const result = safeParse(schema, value);
	if (!result.success)
		throw new InvalidVoiceResponse('The voice response was invalid.');
	return result.data;
};

export const parseVoiceUpdates = (value: unknown): readonly VoiceUpdate[] =>
	parse(voiceListSchema, value).voiceUpdates;

export const parseVoiceContextCars = (
	value: unknown,
): readonly VoiceContextCar[] =>
	parse(voiceContextCarsSchema, value).cars.filter((car) => !car.archivedAt);

export const parseVoiceMutation = (value: unknown): VoiceMutationResponse =>
	parse(voiceMutationSchema, value);

export const voiceGatewayFailure = (error: unknown): VoiceGatewayFailure => {
	if (error instanceof HttpErrorResponse) {
		if (error.status === 0) return { kind: 'unavailable' };
		const apiError = apiErrorSchema.safeParse(error.error);
		return apiError.success
			? {
					kind: 'rejected-response',
					status: error.status,
					message: apiError.data.error,
				}
			: { kind: 'http', status: error.status };
	}
	return error instanceof InvalidVoiceResponse
		? { kind: 'invalid-response' }
		: { kind: 'unavailable' };
};

@Injectable()
export class VoiceGateway {
	private readonly http = inject(HttpClient);
	private readonly carId = signal('');

	readonly updates = httpResource<readonly VoiceUpdate[]>(
		() => {
			const carId = this.carId();
			return carId
				? {
						url: `/api/v1/cars/${encodeURIComponent(carId)}/voice-updates`,
						withCredentials: true,
					}
				: undefined;
		},
		{ parse: parseVoiceUpdates },
	);

	readonly contextCars = httpResource<readonly VoiceContextCar[]>(
		() => ({ url: '/api/v1/cars', withCredentials: true }),
		{ parse: parseVoiceContextCars },
	);

	selectCar(carId: string): void {
		if (this.carId() !== carId) this.carId.set(carId);
	}

	upload(capture: PendingVoiceCapture): Observable<VoiceMutationResponse> {
		return defer(() => {
			const body = capture.blob
				? this.audioCaptureBody(capture)
				: {
						captureId: capture.id,
						text: capture.text,
						driveSessionId: capture.driveSessionId,
					};
			return this.http.post<unknown>(
				`/api/v1/cars/${encodeURIComponent(capture.carId)}/voice-updates`,
				body,
				{ withCredentials: true },
			);
		}).pipe(this.parseMutation());
	}

	process(id: string): Observable<VoiceMutationResponse> {
		return this.http
			.post<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}/process`,
				{},
				{ withCredentials: true },
			)
			.pipe(this.parseMutation());
	}

	correctText(id: string, text: string): Observable<VoiceMutationResponse> {
		return this.http
			.post<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}/corrections`,
				{ text },
				{ withCredentials: true },
			)
			.pipe(this.parseMutation());
	}

	correctAudio(id: string, blob: Blob): Observable<VoiceMutationResponse> {
		return defer(() => {
			const body = new FormData();
			body.set(
				'file',
				new File([blob], `correction-${id}.webm`, {
					type: blob.type || 'audio/webm',
				}),
			);
			return this.http.post<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}/corrections`,
				body,
				{ withCredentials: true },
			);
		}).pipe(this.parseMutation());
	}

	confirm(
		id: string,
		acceptUnresolvedAsNotes: boolean,
	): Observable<VoiceMutationResponse> {
		return this.http
			.post<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}/confirm`,
				{ acceptUnresolvedAsNotes },
				{ withCredentials: true },
			)
			.pipe(this.parseMutation());
	}

	updateContext(
		id: string,
		carId: string,
		driveSessionId: string | null,
	): Observable<VoiceMutationResponse> {
		return this.http
			.patch<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}`,
				{ carId, driveSessionId },
				{ withCredentials: true },
			)
			.pipe(this.parseMutation());
	}

	discard(id: string): Observable<VoiceMutationResponse> {
		return this.http
			.delete<unknown>(`/api/v1/voice-updates/${encodeURIComponent(id)}`, {
				withCredentials: true,
			})
			.pipe(this.parseMutation());
	}

	updatesFailure(): VoiceGatewayFailure | null {
		const error = this.updates.error();
		return error ? voiceGatewayFailure(error) : null;
	}

	refresh(): void {
		this.updates.reload();
	}

	private audioCaptureBody(capture: PendingVoiceCapture): FormData {
		const body = new FormData();
		body.set('captureId', capture.id);
		if (capture.driveSessionId)
			body.set('driveSessionId', capture.driveSessionId);
		body.set(
			'file',
			new File([capture.blob as Blob], capture.fileName, {
				type: capture.contentType,
			}),
		);
		return body;
	}

	private parseMutation() {
		return (source: Observable<unknown>): Observable<VoiceMutationResponse> =>
			source.pipe(
				map(parseVoiceMutation),
				catchError((error: unknown) =>
					throwError(() => voiceGatewayFailure(error)),
				),
			);
	}
}
