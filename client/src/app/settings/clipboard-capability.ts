import { DOCUMENT } from '@angular/common';
import { Injectable, inject } from '@angular/core';
import { defer, from, type Observable, throwError } from 'rxjs';

@Injectable()
export class ClipboardCapability {
	private readonly view = inject(DOCUMENT).defaultView;

	copy(value: string): Observable<void> {
		return defer(() => {
			const clipboard = this.view?.navigator.clipboard;
			return clipboard
				? from(clipboard.writeText(value))
				: throwError(() => new Error('Clipboard unavailable'));
		});
	}
}
