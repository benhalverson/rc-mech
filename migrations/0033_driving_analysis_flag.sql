CREATE TABLE `driving_analysis_flag` (
  `id` integer PRIMARY KEY NOT NULL CHECK (`id` = 1),
  `enabled` integer DEFAULT 0 NOT NULL CHECK (`enabled` IN (0, 1))
);
