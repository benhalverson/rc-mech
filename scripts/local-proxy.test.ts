import { describe, expect, test, vi } from 'vitest';
import {
	exemptIngress,
	ingressPort,
} from '../containers/local-proxy/entrypoint.mts';
import { startLocalWorker } from './local-worker';

describe('local proxy ingress', () => {
	test('accepts both upstream flag forms and rejects invalid listener ports', () => {
		expect(ingressPort(['--http-ingress-address', '0.0.0.0:39001'])).toBe(
			39001,
		);
		expect(ingressPort(['--http-ingress-address=0.0.0.0:39001'])).toBe(39001);
		for (const value of ['', '0.0.0.0:no', '0.0.0.0:0', '0.0.0.0:65536'])
			expect(ingressPort(['--http-ingress-address', value])).toBeNull();
		expect(ingressPort([])).toBeNull();
		expect(ingressPort(['--http-ingress-address'])).toBeNull();
	});

	test('waits for upstream rules and exempts only the local TCP listener', async () => {
		const command = vi.fn().mockReturnValueOnce(false).mockReturnValue(true);
		const pause = vi.fn(async () => undefined);
		await exemptIngress(39001, {
			command,
			isRunning: () => true,
			delay: pause,
		});
		expect(pause).toHaveBeenCalledOnce();
		expect(command.mock.calls.at(-1)?.[0]).toEqual([
			'-t',
			'mangle',
			'-I',
			'PREROUTING',
			'1',
			'-p',
			'tcp',
			'--dport',
			'39001',
			'-m',
			'addrtype',
			'--dst-type',
			'LOCAL',
			'-j',
			'ACCEPT',
		]);
	});

	test('bounds unavailable rules and fails when the exemption cannot be inserted', async () => {
		const pause = vi.fn(async () => undefined);
		await expect(
			exemptIngress(39001, {
				command: () => false,
				isRunning: () => true,
				delay: pause,
			}),
		).rejects.toThrow('did not become ready');
		expect(pause).toHaveBeenCalledTimes(600);
		const command = vi.fn().mockReturnValueOnce(true).mockReturnValue(false);
		await expect(
			exemptIngress(39001, {
				command,
				isRunning: () => true,
				delay: pause,
			}),
		).rejects.toThrow('exemption failed');
	});

	test('does not alter rules after the upstream process exits', async () => {
		const command = vi.fn();
		await exemptIngress(39001, {
			command,
			isRunning: () => false,
			delay: async () => undefined,
		});
		expect(command).not.toHaveBeenCalled();
	});
});

describe('local Worker launcher', () => {
	test('builds before launching local Wrangler and leaves the caller environment intact', async () => {
		const runner = vi.fn(async () => 0);
		const env = { APP_URL: 'http://localhost:4200' };
		expect(await startLocalWorker(['--port', '8798'], env, runner)).toBe(0);
		expect(runner.mock.calls[0]?.[0]).toBe('docker');
		expect(runner.mock.calls[1]).toEqual([
			'pnpm',
			['exec', 'wrangler', 'dev', '--env', 'local', '--port', '8798'],
			{
				...env,
				MINIFLARE_CONTAINER_EGRESS_IMAGE: 'rc-mech-local-container-proxy:local',
				RC_MECH_REAL_DOCKER: 'docker',
				WRANGLER_DOCKER_BIN: expect.stringMatching(
					/rc-mech-local-docker-.*\/docker\.mjs$/,
				),
			},
		]);
		expect(env).toEqual({ APP_URL: 'http://localhost:4200' });
	});

	test('preserves a custom proxy image and never starts Wrangler after a failed build', async () => {
		const runner = vi.fn(async () => 0);
		const env = { MINIFLARE_CONTAINER_EGRESS_IMAGE: 'custom-proxy:local' };
		await startLocalWorker([], env, runner);
		expect(runner).toHaveBeenCalledOnce();
		expect(runner.mock.calls[0]?.[2]).toEqual(env);
		runner.mockClear().mockResolvedValue(7);
		expect(await startLocalWorker([], {}, runner)).toBe(7);
		expect(runner).toHaveBeenCalledOnce();
		expect(runner.mock.calls[0]?.[0]).toBe('docker');
	});
});
