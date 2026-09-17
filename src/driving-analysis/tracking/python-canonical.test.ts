import { expect, test } from 'vitest';
import { asPythonFloat, pythonCanonical } from './python-canonical';

test('retains Python integer-valued floats and both scientific exponent signs', () => {
	expect(
		pythonCanonical({
			z: asPythonFloat(1e16),
			a: asPythonFloat(-1e-6),
			integer: 42,
		}),
	).toBe('{"a":-1e-06,"integer":42,"z":1e+16}');
});

test.each([null, [], true, undefined, 0.5, Number.MAX_SAFE_INTEGER + 1])(
	'rejects unsupported constructed digest data: %s',
	(value) => {
		expect(() => pythonCanonical(value)).toThrow(TypeError);
	},
);

test('escapes DEL consistently with Python ensure_ascii', () => {
	expect(pythonCanonical('\u007f')).toBe('"\\u007f"');
});
