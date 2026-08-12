import { describe, expect, test } from 'vitest';
import {
	bridgeBypassRule,
	diagnoseWorkerd6793,
	findCloudflareProxySidecarIds,
	hasSocketDivertRule,
	isBridgeBypassFirst,
	isWsl2KernelRelease,
	parseDockerBridgeSubnet,
} from './workerd-6793';

describe('workerd issue #6793 support', () => {
	test('recognizes WSL2 kernel releases', () => {
		expect(isWsl2KernelRelease('6.18.33.2-microsoft-standard-WSL2')).toBe(true);
		expect(isWsl2KernelRelease('6.8.0-ubuntu')).toBe(false);
	});

	test('validates the Docker bridge IPv4 subnet', () => {
		expect(parseDockerBridgeSubnet('172.17.0.0/16\n')).toBe('172.17.0.0/16');
		for (const subnet of [
			'172.17.0/16',
			'172..0.0/16',
			'172.17.0.256/16',
			'172.17.0.0/',
			'172.17.0.0/33',
			'172.17.0.0/16/extra',
		]) {
			expect(() => parseDockerBridgeSubnet(subnet)).toThrow(
				'Docker bridge returned an invalid IPv4 subnet',
			);
		}
	});

	test('finds every matching Cloudflare proxy sidecar during replacement', () => {
		expect(
			findCloudflareProxySidecarIds(
				'0123456789ab workerd-rc-mech-local-Issue230PythonContainer-old-proxy\nabcdefabcdef workerd-rc-mech-local-Issue230PythonContainer-new-proxy\n',
			),
		).toEqual(['0123456789ab', 'abcdefabcdef']);
		expect(
			findCloudflareProxySidecarIds(
				'0123456789ab workerd-rc-mech-local-Issue230PythonContainer-id\n',
			),
		).toEqual([]);
		expect(() => findCloudflareProxySidecarIds('not-an-id one-proxy')).toThrow(
			'Docker returned an invalid sidecar container ID',
		);
	});

	test('requires the bridge bypass to be the first PREROUTING rule', () => {
		const subnet = '172.17.0.0/16';
		const bypass = bridgeBypassRule(subnet);
		expect(bypass).toBe(
			'-A PREROUTING -s 172.17.0.0/16 -d 172.17.0.0/16 -j RETURN',
		);
		expect(
			isBridgeBypassFirst(
				`${bypass}\n-A PREROUTING -p tcp -m socket -j DIVERT`,
				subnet,
			),
		).toBe(true);
		expect(
			isBridgeBypassFirst(
				`-A PREROUTING -p tcp -m socket -j DIVERT\n${bypass}`,
				subnet,
			),
		).toBe(false);
		expect(
			hasSocketDivertRule(
				`${bypass}\n-A PREROUTING -p tcp -m socket -j DIVERT`,
			),
		).toBe(true);
		expect(hasSocketDivertRule(bypass)).toBe(false);
	});

	test('diagnoses only the exact WSL2 workerd failure signature', () => {
		const failure = {
			error:
				'round trip returned 503: {"error":{"code":"CONTAINER_UNAVAILABLE"}}',
			kernelRelease: '6.18.33.2-microsoft-standard-WSL2',
			workerLog:
				'kj/timer.c++:30: overloaded: operation timed out\nContainer failed to start',
		};
		expect(diagnoseWorkerd6793(failure)).toMatchObject({
			code: 'CLOUDFLARE_WORKERD_6793',
		});
		expect(
			diagnoseWorkerd6793({ ...failure, kernelRelease: '6.8.0-ubuntu' }),
		).toBeUndefined();
		expect(
			diagnoseWorkerd6793({
				...failure,
				workerLog: 'Container failed to start',
			}),
		).toBeUndefined();
	});
});
