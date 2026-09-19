import { TestBed } from '@angular/core/testing';
import { afterEach, expect, it } from 'vitest';
import { CornerClip } from './corner-clip';

afterEach(() => TestBed.resetTestingModule());
it('renders accessible private playback, pending status, provenance and recoverable errors', () => {
	const fixture = TestBed.createComponent(CornerClip);
	fixture.componentRef.setInput('label', 'Turn one, best pass');
	fixture.detectChanges();
	const root = fixture.nativeElement as HTMLElement;
	expect(root.textContent).toContain('Clip is not ready');
	fixture.componentRef.setInput('clip', {
		id: 'clip',
		cornerId: 'corner',
		ordinal: 1,
		segmentId: 'segment',
		status: 'ready',
		inputDigest: 'input',
		checksum: 'checksum',
		durationMs: 1000,
		pipelineVersion: 'corner-render.v1',
	});
	fixture.detectChanges();
	expect(root.textContent).toContain('being prepared');
	fixture.componentRef.setInput(
		'contentUrl',
		'/api/v1/driving-analyses/analysis/clips/clip/content',
	);
	fixture.detectChanges();
	const video = root.querySelector('video')!;
	expect(video.controls).toBe(true);
	expect(video.getAttribute('aria-label')).toBe('Turn one, best pass');
	expect(video.getAttribute('preload')).toBe('metadata');
	expect(root.textContent).toContain('checksum');
	video.dispatchEvent(new Event('error'));
	fixture.detectChanges();
	expect(root.textContent).toContain('This clip is unavailable');
	fixture.componentRef.setInput(
		'contentUrl',
		'/api/v1/driving-analyses/analysis/clips/other/content',
	);
	fixture.detectChanges();
	expect(root.textContent).not.toContain('This clip is unavailable');
});
