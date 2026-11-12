ALTER TABLE "servers" ADD COLUMN IF NOT EXISTS "update_track" varchar(12) DEFAULT 'auto' NOT NULL;
