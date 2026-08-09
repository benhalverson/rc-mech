import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import {
	baselineFailures,
	diagnosticKey,
	inspectSource,
	sortDiagnostics,
	validateBaseline,
} from './angular-architecture-check';

const ts: typeof import('typescript') = createRequire(
	new URL('../client/package.json', import.meta.url).pathname,
)('typescript');

const source = (text: string) =>
	ts.createSourceFile(
		'fixture.ts',
		text,
		ts.ScriptTarget.Latest,
		true,
		ts.ScriptKind.TS,
	);

describe('Angular architecture checker', () => {
	it('resolves aliased Component decorators and reports deterministic diagnostics', () => {
		const diagnostics = inspectSource(
			source(`
			import { Component as C } from '@angular/core';
			import { HttpClient as Client } from '@angular/common/http';
			@C({ template: '<p/>', styles: ['p{}'] })
			export class Example {
				constructor(private readonly http: Client) {}
				async save() { await this.http.get('/x'); }
				listen(stream: { subscribe(): void }) { stream.subscribe(); }
				read() { return navigator.clipboard; }
			}
		`),
		);
		expect(sortDiagnostics(diagnostics).map(diagnosticKey)).toEqual([
			'fixture.ts:4:27:inline-styles',
			'fixture.ts:4:9:inline-template',
			'fixture.ts:6:40:http-client',
			'fixture.ts:7:20:await',
			'fixture.ts:8:45:manual-subscribe',
			'fixture.ts:9:21:browser-capability',
			'fixture.ts:9:31:browser-capability',
		]);
	});

	it('allows presentation DOM, focus, router, signals, and store commands', () => {
		const diagnostics = inspectSource(
			source(`
			import { Component, signal } from '@angular/core';
			import { Router } from '@angular/router';
			@Component({ templateUrl: './example.html' })
			export class Example {
				value = signal('');
				constructor(private readonly router: Router) {}
				focus(element: HTMLElement) { element.focus(); document.querySelector('h1')?.focus(); }
				go() { void this.router.navigate(['/home']); }
			}
		`),
		);
		expect(diagnostics).toEqual([]);
	});

	it('does not identify decorators with unrelated names', () => {
		expect(
			inspectSource(
				source(`
			import { Component } from '@angular/core';
			@Other({ template: 'bad' })
			export class Example { readonly value = 'ok'; }
		`),
			),
		).toEqual([]);
	});

	it('fails for new and stale baseline entries and rejects malformed baselines', () => {
		const diagnostic = inspectSource(
			source(
				`import { Component } from '@angular/core'; @Component({ templateUrl: './x.html' }) export class Example { read() { return navigator; } }`,
			),
		)[0];
		if (!diagnostic) throw new Error('Expected fixture diagnostic.');
		const failures = baselineFailures(['old:key'], [diagnostic]);
		expect(failures.unexpected.map(diagnosticKey)).toEqual([
			diagnosticKey(diagnostic),
		]);
		expect(failures.stale).toEqual(['old:key']);
		expect(() => validateBaseline({ version: 2, diagnostics: [] })).toThrow();
		expect(() => validateBaseline({ version: 1, diagnostics: [1] })).toThrow();
		expect(validateBaseline({ version: 1, diagnostics: ['x'] })).toEqual(['x']);
	});
});
