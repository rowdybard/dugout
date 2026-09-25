CREATE TABLE `cache` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`version` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`time` integer NOT NULL,
	`price` real,
	`bid` real,
	`ask` real,
	`volume` real,
	`depth` real
);
--> statement-breakpoint
CREATE INDEX `snapshot_slug_time` ON `snapshots` (`slug`,`time`);