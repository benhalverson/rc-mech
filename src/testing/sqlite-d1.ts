import { DatabaseSync } from 'node:sqlite';

const META: D1Meta & Record<string, unknown> = {
	duration: 0,
	size_after: 0,
	rows_read: 0,
	rows_written: 0,
	last_row_id: 0,
	changed_db: false,
	changes: 0,
};

type BoundStatement = {
	query: string;
	values: readonly unknown[];
};

type ScalarSqlValue = null | number | bigint | string;

const sqlValue = (value: unknown): ScalarSqlValue => {
	if (value === null) return null;
	if (typeof value === 'string') return value;
	if (typeof value === 'number') return value;
	if (typeof value === 'bigint') return value;
	if (typeof value === 'boolean') return value ? 1 : 0;
	throw new TypeError(`Unsupported SQLite binding: ${typeof value}`);
};

export type SqliteD1Fixture = {
	database: D1Database;
	close: () => void;
	exec: (query: string) => void;
};

export const createSqliteD1 = (): SqliteD1Fixture => {
	const sqlite = new DatabaseSync(':memory:', {
		enableForeignKeyConstraints: true,
	});
	const bindings = new WeakMap<D1PreparedStatement, BoundStatement>();

	const execute = (
		bound: BoundStatement,
	): D1Result<Record<string, unknown>> => {
		const statement = sqlite.prepare(bound.query);
		const values = bound.values.map(sqlValue);
		const results = statement.all(...values) as Record<string, unknown>[];
		const changeRow = sqlite.prepare('SELECT changes() AS changes').get() as {
			changes: number;
		};
		const changes = changeRow.changes;
		return {
			success: true,
			results,
			meta: {
				...META,
				changes,
				changed_db: changes > 0,
				rows_written: changes,
			},
		};
	};

	const prepare = (query: string): D1PreparedStatement => {
		let values: readonly unknown[] = [];
		const statement: D1PreparedStatement = {
			bind: (...nextValues) => {
				values = nextValues;
				bindings.set(statement, { query, values });
				return statement;
			},
			first: async <T = Record<string, unknown>>(column?: string) => {
				const row = execute({ query, values }).results[0];
				if (!row) return null;
				return (column === undefined ? row : row[column]) as T;
			},
			run: async <T = Record<string, unknown>>() =>
				execute({ query, values }) as D1Result<T>,
			all: async <T = Record<string, unknown>>() =>
				execute({ query, values }) as D1Result<T>,
			raw: (async (options?: { columnNames?: boolean }) => {
				const prepared = sqlite.prepare(query);
				const rows = prepared.all(...values.map(sqlValue)) as Record<
					string,
					unknown
				>[];
				const columns = prepared.columns().map((column) => column.name);
				const rawRows = rows.map((row) => columns.map((column) => row[column]));
				return options?.columnNames ? [columns, ...rawRows] : rawRows;
			}) as D1PreparedStatement['raw'],
		};
		bindings.set(statement, { query, values });
		return statement;
	};

	const batch = async <T = unknown>(statements: D1PreparedStatement[]) => {
		sqlite.exec('BEGIN IMMEDIATE');
		try {
			const results = statements.map((statement) => {
				const bound = bindings.get(statement);
				if (!bound) throw new Error('Unknown prepared statement');
				return execute(bound) as D1Result<T>;
			});
			sqlite.exec('COMMIT');
			return results;
		} catch (error) {
			sqlite.exec('ROLLBACK');
			throw error;
		}
	};

	const session: D1DatabaseSession = {
		prepare,
		batch,
		getBookmark: () => null,
	};
	const database: D1Database = {
		prepare,
		batch,
		exec: async (query) => {
			sqlite.exec(query);
			return { count: 0, duration: 0 };
		},
		withSession: () => session,
		dump: async () => new ArrayBuffer(0),
	};

	return {
		database,
		close: () => sqlite.close(),
		exec: (query) => sqlite.exec(query),
	};
};
