CREATE TABLE `corner_clip` (
	`id` text PRIMARY KEY NOT NULL,
	`input_digest` text NOT NULL,
	`owner_id` text NOT NULL,
	`analysis_id` text NOT NULL,
	`run_id` text NOT NULL,
	`workflow_id` text NOT NULL,
	`batch_artifact_id` text NOT NULL,
	`corner_id` text NOT NULL,
	`pass_ordinal` integer NOT NULL,
	`specification_json` text NOT NULL,
	`source_object_key` text NOT NULL,
	`source_byte_count` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`analysis_id`) REFERENCES `driving_analysis`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`run_id`) REFERENCES `tracking_run`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_artifact_id`) REFERENCES `corner_evidence_batch`(`artifact_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`corner_id`) REFERENCES `track_corner`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corner_clip_input_digest_unique` ON `corner_clip` (`input_digest`);--> statement-breakpoint
CREATE UNIQUE INDEX `corner_clip_pass` ON `corner_clip` (`batch_artifact_id`,`corner_id`,`pass_ordinal`);--> statement-breakpoint
CREATE TABLE `corner_clip_publication` (
	`clip_id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`checksum` text NOT NULL,
	`byte_count` integer NOT NULL,
	`render_input_digest` text NOT NULL,
	`duration_ms` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`clip_id`) REFERENCES `corner_clip`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `corner_clip_publication_object_key_unique` ON `corner_clip_publication` (`object_key`);
