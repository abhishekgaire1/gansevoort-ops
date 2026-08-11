-- Database foundation: extensions
-- gen_random_uuid() is used for all internal UUID primary keys (CLAUDE.md: "Use UUID internal IDs").
create extension if not exists pgcrypto with schema extensions;
