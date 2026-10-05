import { Hono } from 'hono';
import { CornerEvidenceReview } from '../../driving-analysis/evidence/corner-evidence-review';
import type { AppEnv } from '../../types';

export const createCornerEvidenceRoutes = () =>
	new Hono<AppEnv>().get(
		'/driving-analyses/:analysisId/evidence',
		async (c) => {
			const review = await new CornerEvidenceReview(c.env.DB).get(
				c.get('userId'),
				c.req.param('analysisId'),
			);
			c.header('Cache-Control', 'private, no-store');
			return review
				? c.json({ evidence: review })
				: c.json({ error: 'Driving analysis not found' }, 404);
		},
	);
