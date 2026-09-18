import type { AppDependencies } from '../../app-dependencies';
import { PreparedTrackViewAuthority } from '../tracking/prepared-track-view-authority';
import { preparedTrackViewStore } from '../tracking/r2-prepared-track-view-store';
import { cleanupPreparedTrackViews } from '../tracking/track-view-preparation';
import { trackingArtifactPublication } from '../tracking/tracking-artifact-publication';

export async function maintainAnalysisMedia(
	env: Env,
	dependencies: AppDependencies,
): Promise<void> {
	await Promise.allSettled([
		Promise.resolve().then(() =>
			dependencies.raceRecordingAuthority(env).recoverStale(100),
		),
		Promise.resolve().then(() =>
			dependencies.analysisLifecycle(env).cleanup(50),
		),
		Promise.resolve().then(() =>
			cleanupPreparedTrackViews(
				new PreparedTrackViewAuthority(env.DB),
				preparedTrackViewStore(env),
				new Date(),
			),
		),
		Promise.resolve().then(() => trackingArtifactPublication(env).cleanupDue()),
	]);
}
