export const VOICE_MAX_BYTES = 15 * 1024 * 1024;

const supportedAudioTypes = new Set([
	'audio/mp4',
	'audio/mpeg',
	'audio/ogg',
	'audio/wav',
	'audio/webm',
]);

export const validateVoiceMetadata = (value: {
	contentType: string;
	byteSize: number;
}): string | undefined => {
	const mediaType = value.contentType.replace(/;.*$/s, '').trim().toLowerCase();
	if (!supportedAudioTypes.has(mediaType))
		return 'Use a WebM, MP4, MP3, Ogg, or WAV audio recording';
	if (!Number.isInteger(value.byteSize) || value.byteSize <= 0)
		return 'The recording is empty';
	if (value.byteSize > VOICE_MAX_BYTES)
		return 'The recording is larger than the 15 MB limit';
	return undefined;
};

export const voiceObjectKey = (
	ownerId: string,
	carId: string,
	captureId: string,
): string => `voice/${ownerId}/${carId}/${captureId}`;
