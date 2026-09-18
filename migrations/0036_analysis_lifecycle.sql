CREATE TABLE `analysis_deletion` (
	`owner_id` text NOT NULL,
	`analysis_id` text NOT NULL,
	`requested_at` text NOT NULL,
	`deleted_at` text,
	`next_cleanup_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `analysis_id`)
);
--> statement-breakpoint
CREATE INDEX `analysis_deletion_cleanup` ON `analysis_deletion` (`next_cleanup_at`);--> statement-breakpoint
CREATE TABLE `analysis_media_scan` (
	`name` text PRIMARY KEY NOT NULL,
	`cursor` text
);
--> statement-breakpoint
CREATE TABLE `analysis_retry_command` (
	`owner_id` text NOT NULL,
	`command_id` text NOT NULL,
	`analysis_id` text NOT NULL,
	`expected_state_version` integer NOT NULL,
	`workflow_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`owner_id`, `command_id`)
);
--> statement-breakpoint
CREATE TABLE `preparation_intent` (
	`prepared_media_id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`run_id` text NOT NULL,
	`state` text NOT NULL,
	`delete_after` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `preparation_intent_cleanup` ON `preparation_intent` (`delete_after`);
