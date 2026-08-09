import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { relative, resolve } from 'node:path';

export type ArchitectureDiagnostic = {
	file: string;
	line: number;
	column: number;
	kind: string;
	message: string;
};

type Baseline = { version: 1; diagnostics: string[] };

const root = resolve(import.meta.dirname, '..');
const ts: typeof import('typescript') = createRequire(
	resolve(root, 'client/package.json'),
)('typescript');
const clientSource = resolve(root, 'client/src');
const baselinePath = resolve(root, 'tools/angular-architecture-baseline.json');

const productionFiles = (): string[] =>
	ts.sys
		.readDirectory(clientSource, ['.ts'], ['**/*.spec.ts'])
		.filter((file) => !file.endsWith('.spec.ts'))
		.sort();

const property = (object: ts.ObjectLiteralExpression, name: string) =>
	object.properties.find(
		(member): member is ts.PropertyAssignment =>
			ts.isPropertyAssignment(member) &&
			ts.isIdentifier(member.name) &&
			member.name.text === name,
	);

const add = (
	diagnostics: ArchitectureDiagnostic[],
	source: ts.SourceFile,
	node: ts.Node,
	kind: string,
	message: string,
): void => {
	const position = source.getLineAndCharacterOfPosition(node.getStart(source));
	diagnostics.push({
		file: relative(root, source.fileName),
		line: position.line + 1,
		column: position.character + 1,
		kind,
		message,
	});
};

type ComponentImports = {
	named: Set<string>;
	namespaces: Set<string>;
};

const componentImports = (source: ts.SourceFile): ComponentImports => {
	const named = new Set<string>();
	const namespaces = new Set<string>();
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!ts.isStringLiteral(statement.moduleSpecifier) ||
			statement.moduleSpecifier.text !== '@angular/core' ||
			!statement.importClause?.namedBindings
		)
			continue;
		const bindings = statement.importClause.namedBindings;
		if (ts.isNamespaceImport(bindings)) {
			namespaces.add(bindings.name.text);
			continue;
		}
		for (const element of bindings.elements) {
			if (
				element.propertyName?.text === 'Component' ||
				element.name.text === 'Component'
			)
				named.add(element.name.text);
		}
	}
	return { named, namespaces };
};

const isComponentDecorator = (
	expression: ts.LeftHandSideExpression,
	imports: ComponentImports,
): boolean =>
	(ts.isIdentifier(expression) && imports.named.has(expression.text)) ||
	(ts.isPropertyAccessExpression(expression) &&
		ts.isIdentifier(expression.expression) &&
		imports.namespaces.has(expression.expression.text) &&
		expression.name.text === 'Component');

export const inspectSource = (
	source: ts.SourceFile,
): ArchitectureDiagnostic[] => {
	const diagnostics: ArchitectureDiagnostic[] = [];
	const imports = componentImports(source);
	if (!imports.named.size && !imports.namespaces.size) return diagnostics;
	const httpAliases = new Set(['HttpClient']);
	for (const statement of source.statements) {
		if (
			!ts.isImportDeclaration(statement) ||
			!statement.importClause?.namedBindings ||
			!ts.isNamedImports(statement.importClause.namedBindings)
		)
			continue;
		for (const element of statement.importClause.namedBindings.elements)
			if (element.propertyName?.text === 'HttpClient')
				httpAliases.add(element.name.text);
	}
	const visit = (node: ts.Node): void => {
		const decorators = ts.getDecorators(node) ?? [];
		if (ts.isClassDeclaration(node) && decorators.length) {
			for (const decorator of decorators) {
				if (!ts.isCallExpression(decorator.expression)) continue;
				const expression = decorator.expression.expression;
				if (!isComponentDecorator(expression, imports)) continue;
				const metadata = decorator.expression.arguments[0];
				if (metadata && ts.isObjectLiteralExpression(metadata)) {
					for (const name of ['template', 'styles']) {
						const metadataProperty = property(metadata, name);
						if (metadataProperty)
							add(
								diagnostics,
								source,
								metadataProperty,
								`inline-${name}`,
								`Angular components must use an external ${name === 'template' ? 'template' : 'style'} file.`,
							);
					}
				}
			}
			const classEnd = node.end;
			const componentOnly = (child: ts.Node): void => {
				if (child.getStart(source) >= classEnd) return;
				if (ts.isAwaitExpression(child))
					add(
						diagnostics,
						source,
						child,
						'await',
						'Components must not await feature operations.',
					);
				if (
					ts.isCallExpression(child) &&
					ts.isPropertyAccessExpression(child.expression) &&
					child.expression.name.text === 'subscribe'
				)
					add(
						diagnostics,
						source,
						child,
						'manual-subscribe',
						'Components must not manually subscribe to Observables.',
					);
				if (
					ts.isIdentifier(child) &&
					(httpAliases.has(child.text) ||
						[
							'navigator',
							'localStorage',
							'sessionStorage',
							'indexedDB',
							'MediaRecorder',
							'AudioContext',
							'PublicKeyCredential',
							'clipboard',
						].includes(child.text))
				)
					add(
						diagnostics,
						source,
						child,
						httpAliases.has(child.text) ? 'http-client' : 'browser-capability',
						`Components must not access ${child.text} directly.`,
					);
				ts.forEachChild(child, componentOnly);
			};
			for (const member of node.members) componentOnly(member);
		}
		ts.forEachChild(node, visit);
	};
	visit(source);
	return diagnostics;
};

export const diagnosticKey = (diagnostic: ArchitectureDiagnostic): string =>
	`${diagnostic.file}:${diagnostic.line}:${diagnostic.column}:${diagnostic.kind}`;

export const sortDiagnostics = (
	diagnostics: ArchitectureDiagnostic[],
): ArchitectureDiagnostic[] =>
	[...diagnostics].sort((a, b) =>
		diagnosticKey(a).localeCompare(diagnosticKey(b)),
	);

const readBaseline = async (): Promise<Baseline> => {
	let value: unknown;
	try {
		value = JSON.parse(await readFile(baselinePath, 'utf8'));
	} catch {
		throw new Error(`Unable to read architecture baseline: ${baselinePath}`);
	}
	return { version: 1, diagnostics: validateBaseline(value) };
};

export const validateBaseline = (value: unknown): string[] => {
	if (
		!value ||
		typeof value !== 'object' ||
		!('version' in value) ||
		value.version !== 1 ||
		!('diagnostics' in value) ||
		!Array.isArray(value.diagnostics) ||
		value.diagnostics.some((item) => typeof item !== 'string')
	)
		throw new Error(
			'Architecture baseline must be {"version":1,"diagnostics":string[]}.',
		);
	return value.diagnostics;
};

export const collectDiagnostics = async (): Promise<
	ArchitectureDiagnostic[]
> => {
	const diagnostics: ArchitectureDiagnostic[] = [];
	for (const file of productionFiles()) {
		const source = ts.createSourceFile(
			file,
			await readFile(file, 'utf8'),
			ts.ScriptTarget.Latest,
			true,
			ts.ScriptKind.TS,
		);
		diagnostics.push(...inspectSource(source));
	}
	return sortDiagnostics(diagnostics);
};

export const baselineFailures = (
	baselineKeys: string[],
	diagnostics: ArchitectureDiagnostic[],
): { unexpected: ArchitectureDiagnostic[]; stale: string[] } => {
	const current = new Set(diagnostics.map(diagnosticKey));
	const expected = new Set(baselineKeys);
	return {
		unexpected: diagnostics.filter(
			(diagnostic) => !expected.has(diagnosticKey(diagnostic)),
		),
		stale: baselineKeys.filter((key) => !current.has(key)),
	};
};

const main = async (): Promise<void> => {
	const diagnostics = await collectDiagnostics();
	if (process.argv.includes('--write-baseline')) {
		await writeFile(
			baselinePath,
			`${JSON.stringify({ version: 1, diagnostics: diagnostics.map(diagnosticKey) }, null, 2)}\n`,
		);
		return;
	}
	const baseline = await readBaseline();
	const { unexpected, stale } = baselineFailures(
		baseline.diagnostics,
		diagnostics,
	);
	if (unexpected.length || stale.length) {
		for (const diagnostic of unexpected)
			console.error(`NEW ${diagnosticKey(diagnostic)} ${diagnostic.message}`);
		for (const key of stale) console.error(`STALE ${key}`);
		process.exitCode = 1;
	}
};

if (import.meta.main) await main();
