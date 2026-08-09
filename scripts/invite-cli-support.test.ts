import { describe, expect, test, vi } from 'vitest';
import { createOrReuseInvite } from './invite-cli-support';

const json = (body: unknown, status = 200) => Response.json(body, { status });

describe('createOrReuseInvite', () => {
	test('creates once and reuses the same available owned code after a worker restart', async () => {
		const code = {
			code: 'OWNER-SHELL',
			id: 'invite-1',
			status: 'available',
		};
		let created = false;
		const create = vi.fn(async () => {
			if (created)
				return json({ error: 'That invite code is already in use' }, 409);
			created = true;
			return json({ code }, 201);
		});
		const list = vi.fn(async () => json({ codes: [code] }));
		const seed = () =>
			createOrReuseInvite({
				code: code.code,
				create,
				list,
				reuseExisting: true,
			});

		await expect(seed()).resolves.toEqual({
			invite: { code },
			reused: false,
		});
		await expect(seed()).resolves.toEqual({
			invite: { code },
			reused: true,
		});
		expect(create).toHaveBeenCalledTimes(2);
		expect(list).toHaveBeenCalledOnce();
	});

	test('keeps duplicate creation strict unless explicit reuse is safe', async () => {
		const create = vi.fn(async () =>
			json({ error: 'That invite code is already in use' }, 409),
		);
		const list = vi.fn(async () =>
			json({
				codes: [
					{ code: 'OTHER', status: 'available' },
					{ code: 'OWNER-SHELL', status: 'used' },
				],
			}),
		);

		await expect(
			createOrReuseInvite({
				code: 'OWNER-SHELL',
				create,
				list,
				reuseExisting: false,
			}),
		).rejects.toThrow('Invite creation failed (409)');
		expect(list).not.toHaveBeenCalled();

		await expect(
			createOrReuseInvite({
				code: 'OWNER-SHELL',
				create,
				list,
				reuseExisting: true,
			}),
		).rejects.toThrow('Invite creation failed (409)');
	});

	test('reports lookup failures during explicit reuse', async () => {
		await expect(
			createOrReuseInvite({
				code: 'OWNER-SHELL',
				create: async () => json({ error: 'duplicate' }, 409),
				list: async () => new Response('database unavailable', { status: 503 }),
				reuseExisting: true,
			}),
		).rejects.toThrow('Invite lookup failed (503): database unavailable');
	});
});
