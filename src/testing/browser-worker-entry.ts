import { defaultAppDependencies } from '../app-dependencies';
import { RaceRecordingAuthority } from '../driving-analysis/race-recording/race-recording-authority';
import { createWorker } from '../index';

export default createWorker({
	...defaultAppDependencies,
	raceRecordingAuthority: (env) =>
		new RaceRecordingAuthority(env.DB, env.ANALYSIS_MEDIA),
});
