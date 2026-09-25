CREATE TABLE `trading_commands` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`command_id` text NOT NULL,
	`fingerprint` text NOT NULL,
	`value` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trading_commands_user_time` ON `trading_commands` (`user_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `trading_observations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`time` integer NOT NULL,
	`price` real,
	`bid` real,
	`ask` real,
	`depth` real,
	`source` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `trading_observations_slug_time` ON `trading_observations` (`slug`,`time`);