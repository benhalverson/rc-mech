import { spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const localImage = 'rc-mech-local-container-proxy:local';
const docker = process.env['RC_MECH_REAL_DOCKER'] ?? 'docker';
const cachedPull =
	args[0] === 'pull' &&
	args[1] === localImage &&
	(args.length === 2 || (args.length === 4 && args[2] === '--platform'));

// Wrangler pulls every proxy image. Verify our just-built local image instead.
const result = spawnSync(
	docker,
	cachedPull ? ['image', 'inspect', localImage] : args,
	{
		stdio: cachedPull ? ['inherit', 'pipe', 'inherit'] : 'inherit',
		encoding: 'utf8',
	},
);
if (result.error) console.error('Docker could not start.');
process.exitCode = result.status ?? 1;
if (cachedPull && result.status === 0 && args[3]) {
	const inspected: unknown = JSON.parse(result.stdout);
	const record = Array.isArray(inspected) ? inspected[0] : undefined;
	if (
		!record ||
		typeof record !== 'object' ||
		`${record.Os}/${record.Architecture}${record.Variant ? `/${record.Variant}` : ''}` !==
			args[3]
	) {
		console.error(
			'The local proxy image does not match the requested platform.',
		);
		process.exitCode = 1;
	}
}
