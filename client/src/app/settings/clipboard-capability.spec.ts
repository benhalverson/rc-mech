import { DOCUMENT } from '@angular/common';
import { TestBed } from '@angular/core/testing';
import { firstValueFrom } from 'rxjs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ClipboardCapability } from './clipboard-capability';

const capabilityFor = (defaultView: Window | null): ClipboardCapability => {
	TestBed.configureTestingModule({
		providers: [
			ClipboardCapability,
			{ provide: DOCUMENT, useValue: { defaultView } },
		],
	});
	return TestBed.inject(ClipboardCapability);
};

describe('ClipboardCapability', () => {
	afterEach(() => TestBed.resetTestingModule());

	it('copies text through the browser clipboard', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined);
		const capability = capabilityFor({
			navigator: { clipboard: { writeText } },
		} as unknown as Window);

		await expect(firstValueFrom(capability.copy('TRACK-01'))).resolves.toBe(
			undefined,
		);
		expect(writeText).toHaveBeenCalledWith('TRACK-01');
	});

	it('rejects browsers without a clipboard capability', async () => {
		await expect(
			firstValueFrom(capabilityFor(null).copy('TRACK-01')),
		).rejects.toThrow('Clipboard unavailable');
	});
});
