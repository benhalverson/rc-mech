import { expect, test } from 'vitest';
import { trackingRunInputFixture } from '../../testing/prepared-track-view-fixtures';
import {
	canonicalTrackingRunInput,
	digestTrackingRunInput,
} from './tracking-run-input';

test('canonicalizes every immutable Race and Track-map input field', async () => {
	const input = trackingRunInputFixture();
	const canonical = new TextDecoder().decode(canonicalTrackingRunInput(input));

	expect(canonical).toContain(
		'"canonicalizationVersion":"tracking-run-input-c14n.v1"',
	);
	expect(canonical).toContain(`"sourceObjectKey":"${input.sourceObjectKey}"`);
	expect(canonical).toContain(
		`"approvedTrackMapVersionId":"${input.approvedTrackMapVersionId}"`,
	);
	expect(await digestTrackingRunInput(input)).toMatch(/^[0-9a-f]{64}$/);
	expect(await digestTrackingRunInput({ ...input })).toBe(
		await digestTrackingRunInput(input),
	);
});

test.each([
	{ sourceObjectKey: '/absolute' },
	{ sourceObjectKey: 'https://storage.example/source' },
	{ sourceObjectKey: 'race-videos/../source' },
	{ sourceObjectKey: 'race-videos\\source' },
])('rejects non-private source object keys', (override) => {
	expect(() =>
		canonicalTrackingRunInput(trackingRunInputFixture(override)),
	).toThrow();
});

test('rejects a mutable or noncanonical source layout', () => {
	const input = trackingRunInputFixture();
	expect(() =>
		canonicalTrackingRunInput({
			...input,
			sourceLayout: {
				...input.sourceLayout,
				trackView: { x: 0, y: 0, width: 1, height: 1 },
			},
		}),
	).toThrow();
});
