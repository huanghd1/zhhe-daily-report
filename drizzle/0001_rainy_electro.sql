CREATE TABLE `daily_reports` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`date` text NOT NULL,
	`github_trending` text NOT NULL,
	`ai_news` text NOT NULL,
	`ai_analysis` text NOT NULL,
	`github_source` text NOT NULL,
	`github_data_date` text NOT NULL,
	`generated_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `daily_reports_date_unique` ON `daily_reports` (`date`);