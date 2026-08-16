import { getTableConfig } from 'drizzle-orm/sqlite-core';
import { expect, test } from 'vitest';
import { trackingArtifactPromotion } from './authority-schema';

test('defines one indexed promotion lifecycle with immutable authority links', () => {
	const table = getTableConfig(trackingArtifactPromotion);
	expect(table).toMatchObject({
		name: 'tracking_artifact_promotion',
		columns: [
			{ name: 'artifact_id', primary: true, notNull: true },
			{ name: 'run_id', notNull: true },
			{ name: 'segment_id', notNull: true },
			{ name: 'attempt_id', notNull: true },
			{ name: 'transfer_request_id', notNull: true },
			{ name: 'staging_object_key', notNull: true },
			{ name: 'accepted_object_key', notNull: true },
			{ name: 'checksum_sha256', notNull: true },
			{ name: 'contract_digest', notNull: true },
			{ name: 'byte_count', notNull: true },
			{ name: 'state', notNull: true },
			{ name: 'delete_after', notNull: true },
			{ name: 'version', notNull: true },
			{ name: 'created_at', notNull: true },
			{ name: 'updated_at', notNull: true },
			{ name: 'deleted_at', notNull: false },
		],
		indexes: [
			{
				config: { name: 'tracking_artifact_promotion_transfer', unique: true },
			},
			{ config: { name: 'tracking_artifact_promotion_staging', unique: true } },
			{
				config: { name: 'tracking_artifact_promotion_accepted', unique: true },
			},
			{
				config: { name: 'tracking_artifact_promotion_cleanup', unique: false },
			},
		],
	});
	expect(table.foreignKeys).toHaveLength(4);
	for (const foreignKey of table.foreignKeys)
		expect(foreignKey.reference()).toBeDefined();
});
