import { spawn, spawnSync } from 'node:child_process';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

/** Read the upstream proxy's ingress port without accepting an invalid rule. */
export function ingressPort(args: readonly string[]): number | null {
	const argument = args.find((value) =>
		value.startsWith('--http-ingress-address='),
	);
	const separateIndex = args.indexOf('--http-ingress-address');
	const address = argument
		? argument.slice('--http-ingress-address='.length)
		: separateIndex >= 0
			? args[separateIndex + 1]
			: undefined;
	const value = address?.slice(address.lastIndexOf(':') + 1);
	if (!value || !/^\d+$/.test(value)) return null;
	const port = Number(value);
	return port >= 1 && port <= 65_535 ? port : null;
}

type RuleRuntime = Readonly<{
	command(args: string[]): boolean;
	isRunning(): boolean;
	delay(): Promise<void>;
}>;

/** Exempt only the local ingress listener after upstream interception is ready. */
export async function exemptIngress(
	port: number,
	runtime: RuleRuntime,
): Promise<void> {
	const deadline = Date.now() + 30_000;
	for (let attempt = 0; attempt < 600 && Date.now() < deadline; attempt += 1) {
		if (!runtime.isRunning()) return;
		if (
			runtime.command([
				'-t',
				'mangle',
				'-C',
				'PREROUTING',
				'-p',
				'tcp',
				'-m',
				'socket',
				'-j',
				'DIVERT',
			])
		) {
			if (
				!runtime.command([
					'-t',
					'mangle',
					'-I',
					'PREROUTING',
					'1',
					'-p',
					'tcp',
					'--dport',
					String(port),
					'-m',
					'addrtype',
					'--dst-type',
					'LOCAL',
					'-j',
					'ACCEPT',
				])
			)
				throw new Error('Local proxy ingress exemption failed.');
			return;
		}
		await runtime.delay();
	}
	throw new Error('Local proxy interception rules did not become ready.');
}

/** Supervise the unchanged upstream proxy and configure its own namespace only. */
async function main() {
	const args = process.argv.slice(2);
	const proxy = spawn('/proxy-everything', args, { stdio: 'inherit' });
	let shutdownTimer: ReturnType<typeof setTimeout> | undefined;
	const exited = new Promise<number>((resolveExit) => {
		proxy.once('error', () => resolveExit(1));
		proxy.once('exit', (code, signal) =>
			resolveExit(code ?? (signal ? 128 + constants.signals[signal] : 1)),
		);
	});
	/** Bound child shutdown so a stuck upstream process cannot retain the container. */
	const stop = (signal: NodeJS.Signals) => {
		proxy.kill(signal);
		shutdownTimer ??= setTimeout(() => proxy.kill('SIGKILL'), 5_000);
		shutdownTimer.unref();
	};
	/** Forward termination while retaining the child until it has been reaped. */
	const terminate = () => stop('SIGTERM');
	/** Forward interruption to the supervised upstream proxy. */
	const interrupt = () => stop('SIGINT');
	process.once('SIGTERM', terminate);
	process.once('SIGINT', interrupt);
	try {
		const port = ingressPort(args);
		if (port !== null)
			await exemptIngress(port, {
				command: (rule) =>
					spawnSync('iptables', rule, { stdio: 'ignore', timeout: 1_000 })
						.status === 0,
				isRunning: () =>
					proxy.pid !== undefined &&
					proxy.exitCode === null &&
					proxy.signalCode === null,
				delay: () => delay(50),
			});
		process.exitCode = await exited;
	} catch {
		console.error('Local proxy setup failed.');
		stop('SIGTERM');
		await exited.catch(() => undefined);
		process.exitCode = 1;
	} finally {
		clearTimeout(shutdownTimer);
		process.removeListener('SIGTERM', terminate);
		process.removeListener('SIGINT', interrupt);
	}
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
	void main();
