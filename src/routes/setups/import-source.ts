import {
	canonicalSetupImportUrl,
	type SetupImportSource,
} from '../../setup-import-policy';

export const readLimitedText = async (
	response: Response,
	limit = 1_000_000,
) => {
	if (!response.body) return '';
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		while (true) {
			const next = await reader.read();
			if (next.done) break;
			size += next.value.byteLength;
			if (size > limit) throw new Error('Source page is too large');
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return new TextDecoder().decode(bytes);
};

export const fetchSoDialedSource = async (
	url: URL,
): Promise<SetupImportSource> => {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 8_000);
	try {
		const response = await fetch(url, {
			redirect: 'manual',
			headers: { accept: 'text/html' },
			signal: controller.signal,
		});
		if (!response.ok || response.headers.has('location'))
			throw new Error('So Dialed setup page is unavailable');
		const canonicalUrl = canonicalSetupImportUrl(response.url);
		if (!canonicalUrl)
			throw new Error('So Dialed source redirected unexpectedly');
		return { canonicalUrl, html: await readLimitedText(response) };
	} finally {
		clearTimeout(timeout);
	}
};
