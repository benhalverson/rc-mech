import { describe, expect, it } from 'vitest';
import { RaceRecordingFileCapability } from './race-recording-file';

describe('RaceRecordingFileCapability', () => {
	it('keeps private File handles out of workflow state and slices bounded parts', async () => {
		const capability = new RaceRecordingFileCapability();
		expect(capability.file('drive-1')).toBeNull();
		expect(capability.requestId('drive-1')).toBeNull();
		expect(capability.part('drive-1', 0, 1)).toBeNull();
		const file = new File(['abcdef'], 'Race.mp4', { type: 'video/mp4' });
		capability.remember('drive-1', file);
		expect(capability.file('drive-1')).toBe(file);
		expect(capability.requestId('drive-1')).toEqual(expect.any(String));
		expect(await capability.part('drive-1', 1, 4)?.text()).toBe('bcd');
		capability.forget('drive-1');
		expect(capability.file('drive-1')).toBeNull();
		expect(capability.requestId('drive-1')).toBeNull();
		capability.remember('drive-1', file);
		capability.clear();
		expect(capability.file('drive-1')).toBeNull();
	});
});
