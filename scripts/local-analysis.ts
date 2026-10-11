import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:https';
import { resolve } from 'node:path';

/** Loopback-only TLS transport for real local inference; never deploy this script. */
const root = resolve(import.meta.dirname, '..');
const directory = resolve(root, '.wrangler/local-analysis');
const profile =
	process.env.LOCAL_GPU_PROFILE_PATH ?? '/etc/chassis-notes-gpu/profile.json';
const checkpoint =
	process.env.LOCAL_GPU_CHECKPOINT_PATH ??
	'/opt/chassis-notes-gpu/models/sam3.1.pt';
const image =
	process.env.LOCAL_GPU_IMAGE ?? 'chassis-notes-driving-analysis-gpu:current';
const name = 'rc-mech-local-analysis-gpu';
const run = (command: string, args: string[]) => {
	const result = spawnSync(command, args, {
		stdio: ['ignore', 'pipe', 'pipe'],
	});
	if (result.status !== 0)
		throw new Error(`${command} failed while preparing local analysis`);
	return result.stdout.toString().trim();
};

mkdirSync(directory, { recursive: true, mode: 0o700 });
const key = resolve(directory, 'localhost.key');
const certificate = resolve(directory, 'localhost.crt');
if (!existsSync(certificate) || !existsSync(key)) {
	run('openssl', [
		'req',
		'-x509',
		'-newkey',
		'rsa:2048',
		'-nodes',
		'-keyout',
		key,
		'-out',
		certificate,
		'-days',
		'30',
		'-subj',
		'/CN=rc-mech-local-analysis',
		'-addext',
		'subjectAltName=IP:127.0.0.1,DNS:localhost',
	]);
}
const profileJson = JSON.stringify(
	JSON.parse(
		run('docker', [
			'run',
			'--rm',
			'--network',
			'none',
			'--entrypoint',
			'cat',
			'--mount',
			`type=bind,src=${profile},dst=/local-profile.json,readonly`,
			image,
			'/local-profile.json',
		]),
	),
);
const variablesPath = resolve(root, '.dev.vars.local');
const original = readFileSync(variablesPath, 'utf8');
const withoutDemo = original
	.split('\n')
	.filter(
		(line) => !/^(LOCAL_ANALYSIS_SECRET|INFERENCE_PROFILE_JSON)=/.test(line),
	)
	.join('\n')
	.trimEnd();
const configured = `${withoutDemo}\nLOCAL_ANALYSIS_SECRET=${randomBytes(32).toString('hex')}\nINFERENCE_PROFILE_JSON='${profileJson}'\n`;

const server = createServer(
	{ key: readFileSync(key), cert: readFileSync(certificate) },
	(incoming, outgoing) => {
		if (
			!incoming.url?.startsWith('/__local-analysis-transfer?') ||
			!['GET', 'PUT'].includes(incoming.method ?? '')
		) {
			outgoing.writeHead(404).end();
			return;
		}
		const upstream = request(
			{
				hostname: '127.0.0.1',
				port: 8787,
				path: incoming.url,
				method: incoming.method,
				headers: { ...incoming.headers, host: '127.0.0.1:8787' },
			},
			(response) => {
				outgoing.writeHead(response.statusCode ?? 502, response.headers);
				response.pipe(outgoing);
			},
		);
		upstream.on('error', () => {
			if (!outgoing.headersSent) outgoing.writeHead(502);
			outgoing.end();
		});
		incoming.on('aborted', () => upstream.destroy());
		incoming.pipe(upstream);
	},
);

await new Promise<void>((accept, reject) => {
	server.once('error', reject);
	server.listen(9443, '127.0.0.1', accept);
});
let started = false;
const cleanup = () => {
	if (started) {
		run('docker', ['stop', '--time', '15', name]);
		started = false;
	}
	if (readFileSync(variablesPath, 'utf8') === configured)
		writeFileSync(variablesPath, original, { mode: 0o600 });
	server.close();
};
try {
	run('docker', ['volume', 'create', 'rc-mech-local-analysis-state']);
	run('docker', [
		'run',
		'--detach',
		'--rm',
		'--name',
		name,
		'--gpus',
		'all',
		'--network',
		'host',
		'--read-only',
		'--cap-drop',
		'ALL',
		'--security-opt',
		'no-new-privileges',
		'--memory',
		'24g',
		'--shm-size',
		'2g',
		'--tmpfs',
		'/tmp:rw,nosuid,nodev,size=8g,mode=1777',
		'--mount',
		'type=volume,src=rc-mech-local-analysis-state,dst=/var/lib/chassis-notes-gpu',
		'--mount',
		`type=bind,src=${profile},dst=/etc/chassis-notes-gpu/profile.json,readonly`,
		'--mount',
		`type=bind,src=${checkpoint},dst=/models/sam3.1.pt,readonly`,
		'--mount',
		`type=bind,src=${certificate},dst=/etc/local-analysis.crt,readonly`,
		'-e',
		'SSL_CERT_FILE=/etc/local-analysis.crt',
		'-e',
		'GPU_INFERENCE_PROFILE_PATH=/etc/chassis-notes-gpu/profile.json',
		'-e',
		'SAM31_CHECKPOINT_PATH=/models/sam3.1.pt',
		image,
		'python',
		'-m',
		'uvicorn',
		'--factory',
		'chassis_notes_gpu_worker.api:create_app',
		'--host',
		'127.0.0.1',
		'--port',
		'8081',
		'--no-server-header',
		'--no-access-log',
	]);
	started = true;
	writeFileSync(variablesPath, configured, { mode: 0o600 });
	console.log(
		'Local analysis transport is running. GPU: 127.0.0.1:8081; signed media: 127.0.0.1:9443.',
	);
	console.log(
		'Restart pnpm worker:dev to load the local profile and capability key. Keep this process running for the demo.',
	);
	for (const signal of ['SIGINT', 'SIGTERM'] as const)
		process.once(signal, () => {
			cleanup();
			process.exit(0);
		});
} catch (error) {
	cleanup();
	throw error;
}
