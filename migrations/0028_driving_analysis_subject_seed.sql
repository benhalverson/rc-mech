ALTER TABLE driving_analysis ADD COLUMN subject_seed_frame_index INTEGER NOT NULL DEFAULT 0 CHECK (subject_seed_frame_index >= 0);
ALTER TABLE driving_analysis ADD COLUMN subject_seed_identity TEXT NOT NULL DEFAULT 'subject-1' CHECK (length(subject_seed_identity) BETWEEN 1 AND 128);
