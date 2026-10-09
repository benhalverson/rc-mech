import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { inject, Service } from '@angular/core';
import { catchError, defer, map, throwError } from 'rxjs';
import type { PendingVoiceCapture, VoiceGatewayFailure } from './voice.models';
import { voiceMutationSchema } from './voice.models';
import {
	parseVoiceMutation,
	parseVoiceUpdates,
	voiceGatewayFailure,
} from './voice-gateway';

class MisdirectedVoiceResponse extends Error {}
const failure = (
	error: unknown,
	processingId?: string,
): VoiceGatewayFailure => {
	if (error instanceof MisdirectedVoiceResponse)
		return { kind: 'invalid-response' };
	if (error instanceof HttpErrorResponse && error.status >= 500) {
		if (processingId) {
			const parsed = voiceMutationSchema.safeParse(error.error);
			if (
				parsed.success &&
				parsed.data.voiceUpdate.id === processingId &&
				parsed.data.voiceUpdate.status === 'failed'
			)
				return {
					kind: 'rejected-response',
					status: error.status,
					message:
						parsed.data.voiceUpdate.error ??
						'Voice processing failed. The original recording remains saved.',
				};
		}
		return { kind: 'unavailable' };
	}
	return voiceGatewayFailure(error);
};
@Service()
export class VoiceSyncGateway {
	private readonly http = inject(HttpClient);
	load() {
		return this.http
			.get<unknown>('/api/v1/voice-updates', { withCredentials: true })
			.pipe(map(parseVoiceUpdates));
	}
	upload(capture: PendingVoiceCapture) {
		return defer(() => {
			let body:
				| FormData
				| Readonly<{
						captureId: string;
						text: string | undefined;
						driveSessionId: string | null;
				  }>;
			if (capture.blob) {
				body = new FormData();
				body.set('captureId', capture.id);
				if (capture.driveSessionId)
					body.set('driveSessionId', capture.driveSessionId);
				body.set(
					'file',
					new File([capture.blob], capture.fileName, {
						type: capture.contentType,
					}),
				);
			} else
				body = {
					captureId: capture.id,
					text: capture.text,
					driveSessionId: capture.driveSessionId,
				};
			return this.http.post<unknown>(
				`/api/v1/cars/${encodeURIComponent(capture.carId)}/voice-updates`,
				body,
				{ withCredentials: true },
			);
		}).pipe(
			map(parseVoiceMutation),
			map((response) => {
				if (
					response.voiceUpdate.id !== capture.id ||
					response.voiceUpdate.carId !== capture.carId ||
					response.voiceUpdate.driveSessionId !== capture.driveSessionId
				)
					throw new MisdirectedVoiceResponse(
						'Misdirected voice acknowledgement',
					);
				return response;
			}),
			catchError((error) => throwError(() => failure(error))),
		);
	}
	process(id: string) {
		return this.http
			.post<unknown>(
				`/api/v1/voice-updates/${encodeURIComponent(id)}/process`,
				{},
				{ withCredentials: true },
			)
			.pipe(
				map(parseVoiceMutation),
				map((response) => {
					if (response.voiceUpdate.id !== id)
						throw new MisdirectedVoiceResponse(
							'Misdirected processing acknowledgement',
						);
					return response;
				}),
				catchError((error) => throwError(() => failure(error, id))),
			);
	}
}
