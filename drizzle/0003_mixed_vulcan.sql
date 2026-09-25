CREATE TABLE `tennis_journal` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tennis_journal_session_time` ON `tennis_journal` (`session_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `tennis_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`time` integer NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `tennis_observations_slug_time` ON `tennis_observations` (`slug`,`time`);--> statement-breakpoint
CREATE TABLE `tennis_sessions` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL
);
