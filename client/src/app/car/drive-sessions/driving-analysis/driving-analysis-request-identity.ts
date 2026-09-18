import { Service } from '@angular/core';
import type { StartDrivingAnalysisCommand } from './driving-analysis.models';

@Service({ autoProvided: false })
export class DrivingAnalysisRequestIdentityCapability {
	private readonly identities = new Map<
		string,
		Readonly<{ fingerprint: string; requestId: string }>
	>();

	requestId(command: StartDrivingAnalysisCommand): string {
		const fingerprint = JSON.stringify(command);
		const previous = this.identities.get(command.driveSessionId);
		if (previous?.fingerprint === fingerprint) return previous.requestId;
		const requestId = crypto.randomUUID();
		this.identities.set(command.driveSessionId, { fingerprint, requestId });
		return requestId;
	}

	clear(): void {
		this.identities.clear();
	}
	retryId(analysisId: string, stateVersion: number): string {
		const key = `retry:${analysisId}:${stateVersion}`;
		const previous = this.identities.get(key);
		if (previous) return previous.requestId;
		const requestId = crypto.randomUUID();
		this.identities.set(key, { fingerprint: key, requestId });
		return requestId;
	}
}
