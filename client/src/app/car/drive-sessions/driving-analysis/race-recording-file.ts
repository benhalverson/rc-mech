import { Injectable } from '@angular/core';

@Injectable()
export class RaceRecordingFileCapability {
	private readonly selections = new Map<
		string,
		Readonly<{ file: File; requestId: string }>
	>();

	remember(driveSessionId: string, file: File): void {
		this.selections.set(driveSessionId, {
			file,
			requestId: crypto.randomUUID(),
		});
	}

	file(driveSessionId: string): File | null {
		return this.selections.get(driveSessionId)?.file ?? null;
	}

	requestId(driveSessionId: string): string | null {
		return this.selections.get(driveSessionId)?.requestId ?? null;
	}

	part(driveSessionId: string, start: number, end: number): Blob | null {
		return this.file(driveSessionId)?.slice(start, end) ?? null;
	}

	forget(driveSessionId: string): void {
		this.selections.delete(driveSessionId);
	}

	clear(): void {
		this.selections.clear();
	}
}
