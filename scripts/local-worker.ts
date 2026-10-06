import { spawn } from 'node:child_process';
import {
	chmod,
	copyFile,
	mkdtemp,
	readFile,
	rm,
	writeFile,
} from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';
import { constants, tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const image = 'rc-mech-local-container-proxy:local';

/** Generate an isolated Docker context from the maintained TypeScript entrypoint. */
export async function prepareProxyContext() {
	const directory = await mkdtemp(resolve(tmpdir(), 'rc-mech-local-proxy-'));
	try {
		const source = await readFile(
			resolve(root, 'containers/local-proxy/entrypoint.mts'),
			'utf8',
		);
		await copyFile(
			resolve(root, 'containers/local-proxy/Dockerfile'),
			resolve(directory, 'Dockerfile'),
		);
		await writeFile(
			resolve(directory, 'entrypoint.mjs'),
			stripTypeScriptTypes(source),
		);
		return directory;
	} catch (error) {
		await rm(directory, { recursive: true, force: true });
		throw error;
	}
}

/** Run local tooling without a shell, forwarding shutdown to the active child. */
async function run(command: string, args: string[], env: NodeJS.ProcessEnv) {
	const child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
	/** Forward the launcher's termination signal to its current subprocess. */
	const terminate = () => child.kill('SIGTERM');
	/** Forward an interactive interrupt to the current subprocess. */
	const interrupt = () => child.kill('SIGINT');
	process.once('SIGTERM', terminate);
	process.once('SIGINT', interrupt);
	try {
		return await new Promise<number>((resolveExit, reject) => {
			child.once('error', reject);
			child.once('exit', (code, signal) =>
				resolveExit(code ?? (signal ? 128 + constants.signals[signal] : 1)),
			);
		});
	} finally {
		process.removeListener('SIGTERM', terminate);
		process.removeListener('SIGINT', interrupt);
	}
}

/** Build the local-only proxy and launch Wrangler with the caller's environment. */
export async function startLocalWorker(
	args: readonly string[],
	callerEnvironment: NodeJS.ProcessEnv = process.env,
	runner: typeof run = run,
) {
	const env = { ...callerEnvironment };
	let toolingDirectory: string | undefined;
	if (!env['MINIFLARE_CONTAINER_EGRESS_IMAGE']) {
		const directory = await prepareProxyContext();
		try {
			const code = await runner(
				'docker',
				['build', '--pull=false', '--tag', image, directory],
				env,
			);
			if (code !== 0) return code;
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
		env['MINIFLARE_CONTAINER_EGRESS_IMAGE'] = image;
		toolingDirectory = await mkdtemp(
			resolve(tmpdir(), 'rc-mech-local-docker-'),
		);
		const executable = resolve(toolingDirectory, 'docker.mjs');
		try {
			const source = await readFile(
				resolve(root, 'scripts/local-docker.mts'),
				'utf8',
			);
			await writeFile(
				executable,
				`#!${process.execPath}\n${stripTypeScriptTypes(source)}`,
			);
			await chmod(executable, 0o700);
			env['RC_MECH_REAL_DOCKER'] = env['WRANGLER_DOCKER_BIN'] ?? 'docker';
			env['WRANGLER_DOCKER_BIN'] = executable;
		} catch (error) {
			await rm(toolingDirectory, { recursive: true, force: true });
			throw error;
		}
	}
	try {
		return await runner(
			'pnpm',
			['exec', 'wrangler', 'dev', '--env', 'local', ...args],
			env,
		);
	} finally {
		if (toolingDirectory)
			await rm(toolingDirectory, { recursive: true, force: true });
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	void startLocalWorker(process.argv.slice(2)).then(
		(code) => {
			process.exitCode = code;
		},
		() => {
			console.error('Local Worker tooling could not start.');
			process.exitCode = 1;
		},
	);
