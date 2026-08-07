#!/usr/bin/env node

const args = process.argv.slice(2);
const value = (name) => {
	const index = args.indexOf(`--${name}`);
	return index === -1 ? undefined : args[index + 1];
};
const database = value('database') ?? 'DB';
const creator = value('creator');
const rawCode = value('code');
const remote = args.includes('--remote');
const local = args.includes('--local');
const code = rawCode?.trim().toUpperCase();
const reserved = new Set([
	'ADMIN',
	'API',
	'AUTH',
	'GARAGE',
	'LOGIN',
	'OWNER',
	'REGISTER',
	'ROOT',
	'SETTINGS',
	'SIGN-IN',
	'SYSTEM',
	'USER',
	'WWW',
]);
if (
	!creator ||
	!code ||
	(!remote && !local) ||
	!/^[A-Z0-9-]{6,32}$/.test(code) ||
	reserved.has(code)
) {
	console.error(
		'Usage: pnpm db:seed-invite --database DB --local|--remote --creator OWNER_ID --code CODE',
	);
	process.exit(2);
}
const sql = `INSERT INTO invite_code (id, code, creator_id, status, created_at, updated_at) VALUES ('seed-${Date.now()}', '${code.replaceAll("'", "''")}', '${creator.replaceAll("'", "''")}', 'available', datetime('now'), datetime('now'));`;
const flags = remote ? ['--remote'] : ['--local', '--env', 'local'];
const child = (await import('node:child_process')).spawn(
	'pnpm',
	['exec', 'wrangler', 'd1', 'execute', database, ...flags, '--command', sql],
	{ stdio: 'inherit' },
);
child.on('exit', (status) => process.exit(status ?? 1));
