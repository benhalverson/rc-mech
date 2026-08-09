const isValidTimezone = (value: unknown): value is string => {
	if (typeof value !== 'string' || !value.trim()) return false;
	try {
		new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
		return true;
	} catch {
		return false;
	}
};

export const safeTimezone = (value: unknown): string =>
	isValidTimezone(value) ? value : 'UTC';

export const browserTimezone = (): string => {
	try {
		return safeTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
	} catch {
		return 'UTC';
	}
};

export const localDateTime = (iso: string, timezone: string): string => {
	const parts = new Intl.DateTimeFormat('en-CA', {
		timeZone: safeTimezone(timezone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(iso));
	const get = (type: string) =>
		parts.find((part) => part.type === type)?.value ?? '';
	return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
};

export const toIso = (value: string, timezone: string): string => {
	const [date, time] = value.split('T');
	if (!date || !time) return '';
	const [year, month, day] = date.split('-').map(Number);
	const [hour, minute] = time.split(':').map(Number);
	const asUtc = Date.UTC(year, month - 1, day, hour, minute);
	const parts = new Intl.DateTimeFormat('en-US', {
		timeZone: safeTimezone(timezone),
		year: 'numeric',
		month: '2-digit',
		day: '2-digit',
		hour: '2-digit',
		minute: '2-digit',
		hourCycle: 'h23',
	}).formatToParts(new Date(asUtc));
	const get = (type: string) =>
		Number(parts.find((part) => part.type === type)?.value);
	const offset =
		Date.UTC(
			get('year'),
			get('month') - 1,
			get('day'),
			get('hour'),
			get('minute'),
		) - asUtc;
	return new Date(asUtc - offset).toISOString();
};
