// Python json.dumps compatibility for existing Tracking digests.
// Inference-profile canonicalization is separately versioned.
const pythonFloat = (value: number): string => {
	if (Object.is(value, -0)) return '-0.0';
	if (value !== 0 && (Math.abs(value) < 1e-4 || Math.abs(value) >= 1e16))
		return value
			.toExponential()
			.replace(
				/e([+-])(\d+)$/,
				(_match, sign, exponent) => `e${sign}${exponent.padStart(2, '0')}`,
			);
	if (Number.isInteger(value)) return `${value}.0`;
	return String(value);
};

class PythonFloatValue {
	constructor(readonly value: number) {}
}

export const asPythonFloat = (value: number): PythonFloatValue =>
	new PythonFloatValue(value);

export const pythonCanonical = (value: unknown): string => {
	if (typeof value === 'string') return pythonString(value);
	if (typeof value === 'number') {
		if (!Number.isSafeInteger(value))
			throw new TypeError('Unsupported Python canonical value');
		return String(value);
	}
	if (value instanceof PythonFloatValue) return pythonFloat(value.value);
	if (typeof value !== 'object' || value === null || Array.isArray(value))
		throw new TypeError('Unsupported Python canonical value');
	return `{${Object.entries(value)
		.sort(([left], [right]) => (left < right ? -1 : 1))
		.map(([key, item]) => `${pythonString(key)}:${pythonCanonical(item)}`)
		.join(',')}}`;
};

const pythonString = (value: string): string =>
	JSON.stringify(value)
		.split('')
		.map((character) =>
			character.charCodeAt(0) >= 0x7f
				? `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`
				: character,
		)
		.join('');
