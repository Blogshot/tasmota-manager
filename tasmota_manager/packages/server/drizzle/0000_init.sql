CREATE TABLE `device_tags` (
	`device_id` text NOT NULL,
	`tag_id` integer NOT NULL,
	PRIMARY KEY(`device_id`, `tag_id`),
	FOREIGN KEY (`device_id`) REFERENCES `devices`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `devices` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`hostname` text,
	`ip` text,
	`mqtt_topic` text,
	`full_topic` text,
	`module` text,
	`firmware` text,
	`variant` text,
	`chip` text,
	`flash_size` integer,
	`rssi` integer,
	`uptime_sec` integer,
	`online` integer DEFAULT false NOT NULL,
	`auth_required` integer DEFAULT false NOT NULL,
	`channels` text DEFAULT '[]' NOT NULL,
	`http_failures` integer DEFAULT 0 NOT NULL,
	`last_seen` text,
	`status_json` text,
	`password_override` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value_json` text
);
--> statement-breakpoint
CREATE TABLE `tags` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`name` text NOT NULL,
	`color` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tags_name_unique` ON `tags` (`name`);