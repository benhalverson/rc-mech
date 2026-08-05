import { setupImportSourceUrl } from './types.ts';

export type SetupImportSource = {
	canonicalUrl: string;
	html: string;
};

export type SetupImportExtraction = {
	sourceIdentity?: Record<string, unknown>;
	sourcePdfReference?: string;
	sourceMetadata?: Record<string, unknown>;
	knownValues: Record<string, unknown>;
	uncertainValues: Record<string, unknown>;
	rawValues: Record<string, unknown>;
	unmappedValues: Record<string, unknown>;
};

export type SetupImportResolver = (url: URL) => Promise<SetupImportSource>;
export type SetupImportExtractor = (
	source: SetupImportSource,
) => Promise<SetupImportExtraction> | SetupImportExtraction;

export const canonicalSetupImportUrl = (value: string): string | null => {
	const parsed = setupImportSourceUrl.safeParse(value);
	if (!parsed.success) return null;
	const url = new URL(parsed.data);
	url.hostname = 'www.sodialed.com';
	url.hash = '';
	url.search = '';
	url.pathname = url.pathname.replace(/\/$/, '');
	return url.toString();
};

export const sourceKeyFor = (value: string): string | null =>
	canonicalSetupImportUrl(value);

export const importDraftStatus = {
	draft: 'draft',
	accepted: 'accepted',
	cancelled: 'cancelled',
	error: 'error',
} as const;

export const isSupportedPdfReference = (value: string): boolean => {
	try {
		const url = new URL(value);
		return (
			url.protocol === 'https:' && url.username === '' && url.password === ''
		);
	} catch {
		return false;
	}
};

export const defaultImportExtractor: SetupImportExtractor = (source) => {
	const meta = (name: string): string | undefined => {
		const match = source.html.match(
			new RegExp(
				`<meta[^>]+(?:property|name)=["']${name}["'][^>]+content=["']([^"']*)["']`,
				'i',
			),
		);
		return match?.[1]?.trim() || undefined;
	};
	const pdf = source.html.match(
		/href=["'](https:\/\/[^"']+\.pdf(?:\?[^"']*)?)["']/i,
	)?.[1];
	const title = meta('og:title');
	const description = meta('og:description');
	return {
		sourceIdentity: title ? { title } : {},
		sourcePdfReference: pdf && isSupportedPdfReference(pdf) ? pdf : undefined,
		sourceMetadata: description ? { description } : {},
		knownValues: {},
		uncertainValues: {},
		rawValues: title || description ? { title, description } : {},
		unmappedValues: {},
	};
};

export const resolveSetupImport = async (
	value: string,
	resolver: SetupImportResolver,
	extractor: SetupImportExtractor,
): Promise<SetupImportExtraction & { canonicalUrl: string }> => {
	const canonicalUrl = canonicalSetupImportUrl(value);
	if (!canonicalUrl) throw new Error('Unsupported So Dialed setup URL');
	return {
		canonicalUrl,
		...(await extractor(await resolver(new URL(canonicalUrl)))),
	};
};
