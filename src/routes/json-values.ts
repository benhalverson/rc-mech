export const jsonText = (value: unknown): string | null | undefined =>
	value === undefined
		? undefined
		: value === null
			? null
			: JSON.stringify(value);

export const jsonValue = (value: string | null): unknown => {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
};
