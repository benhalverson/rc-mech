import { Service } from '@angular/core';

@Service()
export class VoiceConnectivity {
	isOnline(): boolean {
		return typeof navigator === 'undefined' || navigator.onLine;
	}
}
