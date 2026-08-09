export const isSupportedSoDialedUrl = (value: string): boolean => {
	try {
		const url = new URL(value.trim());
		return (
			url.protocol === 'https:' &&
			(url.hostname === 'sodialed.com' ||
				url.hostname === 'www.sodialed.com') &&
			url.username === '' &&
			url.password === '' &&
			(url.port === '' || url.port === '443') &&
			/^\/setup\/[A-Za-z0-9]+\/?$/.test(url.pathname)
		);
	} catch {
		return false;
	}
};
