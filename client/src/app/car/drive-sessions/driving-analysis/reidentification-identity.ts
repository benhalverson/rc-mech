import { Service } from '@angular/core';
import type { ReidentifySubjectCommand } from './reidentification.models';

@Service()
export class ReidentificationIdentity {
	private readonly identities = new Map<string, string>();
	forCommand(command: ReidentifySubjectCommand): string {
		const key = JSON.stringify(command);
		const existing = this.identities.get(key);
		if (existing) return existing;
		const id = crypto.randomUUID();
		this.identities.set(key, id);
		return id;
	}
}
