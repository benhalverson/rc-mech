import { spawn } from 'node:child_process';

const run = async (executable: string, args: readonly string[]) => {
	const child = spawn(executable, args, {
		cwd: process.cwd(),
		stdio: 'inherit',
	});
	const exitCode = await new Promise<number | null>((resolve, reject) => {
		child.once('error', reject);
		child.once('close', resolve);
	});
	if (exitCode !== 0)
		throw new Error(
			`${executable} ${args.join(' ')} failed with exit code ${exitCode}`,
		);
};

await run('docker', [
	'build',
	'--target',
	'test',
	'--tag',
	'rc-mech-issue-230-test',
	'prototypes/issue-230/python',
]);
await run('docker', ['run', '--rm', 'rc-mech-issue-230-test']);
await run('pnpm', [
	'exec',
	'vitest',
	'run',
	'src/issue-230-container-routes.test.ts',
	'--coverage.enabled=false',
]);
