import { afterEach, expect, test, vi } from 'vitest';
import { CornerEvidenceReview } from '../../driving-analysis/evidence/corner-evidence-review';
import { createHonoFixture } from '../../testing/hono-fixture';

afterEach(() => vi.restoreAllMocks());

test('returns private owner-scoped accepted evidence and hides missing analyses', async () => {
	const evidence = {
		analysisId: 'analysis-1',
		carId: 'car-1',
		driveSessionId: 'drive-1',
		stateVersion: 1,
		status: 'running',
		runId: null,
		trackMapVersionId: 'map-1',
		tieToleranceMs: null,
		corners: [],
	};
	const get = vi
		.spyOn(CornerEvidenceReview.prototype, 'get')
		.mockResolvedValue(evidence);
	const { request } = createHonoFixture();
	const response = await request(
		'/api/v1/driving-analyses/analysis-1/evidence',
	);
	expect(response.status).toBe(200);
	expect(response.headers.get('cache-control')).toBe('private, no-store');
	expect(await response.json()).toEqual({ evidence });
	expect(get).toHaveBeenCalledWith('owner-1', 'analysis-1');
	get.mockResolvedValue(null);
	expect(
		(await request('/api/v1/driving-analyses/other/evidence')).status,
	).toBe(404);
});
