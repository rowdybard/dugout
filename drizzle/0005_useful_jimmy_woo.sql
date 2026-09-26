CREATE TABLE `tennis_runner_chunks` (
	`owner_id` text NOT NULL,
	`epoch` text NOT NULL,
	`idx` integer NOT NULL,
	`data` text NOT NULL,
	`sha256` text NOT NULL,
	`byte_length` integer NOT NULL,
	PRIMARY KEY(`owner_id`, `epoch`, `idx`)
);
--> statement-breakpoint
CREATE TABLE `tennis_runner_owners` (
	`owner_id` text PRIMARY KEY NOT NULL,
	`mode` text NOT NULL,
	`epoch` text NOT NULL,
	`migration_id` text NOT NULL,
	`source_session_id` text NOT NULL,
	`source_revision` integer NOT NULL,
	`original_snapshot` text NOT NULL,
	`snapshot` text NOT NULL,
	`journal_through` integer NOT NULL,
	`journal_total` integer NOT NULL,
	`journal_cursor` integer DEFAULT 0 NOT NULL,
	`journal_done` integer DEFAULT 0 NOT NULL,
	`observation_cursor` text DEFAULT '' NOT NULL,
	`observation_done` integer DEFAULT 0 NOT NULL,
	`next_chunk` integer DEFAULT 0 NOT NULL,
	`uploaded_chunks` integer DEFAULT 0 NOT NULL,
	`remote_started` integer DEFAULT 0 NOT NULL,
	`phase` text NOT NULL,
	`manifest` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "tennis_runner_owner_mode" CHECK("tennis_runner_owners"."mode" IN ('frozen','active')),
	CONSTRAINT "tennis_runner_owner_phase" CHECK("tennis_runner_owners"."phase" IN ('journal','observations','ready','uploading','active'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tennis_runner_owners_epoch_unique` ON `tennis_runner_owners` (`epoch`);--> statement-breakpoint
CREATE UNIQUE INDEX `tennis_runner_owners_migration_id_unique` ON `tennis_runner_owners` (`migration_id`);--> statement-breakpoint
CREATE TABLE `tennis_runner_refs` (
	`owner_id` text NOT NULL,
	`epoch` text NOT NULL,
	`observation_id` text NOT NULL,
	PRIMARY KEY(`owner_id`, `epoch`, `observation_id`)
);
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_session_update BEFORE UPDATE ON tennis_sessions
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=OLD.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper session moved to its fenced background runner.'); END;
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_session_insert BEFORE INSERT ON tennis_sessions
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=NEW.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper session moved to its fenced background runner.'); END;
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_session_delete BEFORE DELETE ON tennis_sessions
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=OLD.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper session moved to its fenced background runner.'); END;
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_journal_insert BEFORE INSERT ON tennis_journal
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=NEW.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper journal moved to its fenced background runner.'); END;
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_journal_update BEFORE UPDATE ON tennis_journal
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=OLD.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper journal moved to its fenced background runner.'); END;
--> statement-breakpoint
CREATE TRIGGER tennis_runner_fence_journal_delete BEFORE DELETE ON tennis_journal
WHEN EXISTS(SELECT 1 FROM tennis_runner_owners WHERE owner_id=OLD.owner_id AND mode IN ('frozen','active'))
BEGIN SELECT RAISE(ABORT,'Paper journal moved to its fenced background runner.'); END;

