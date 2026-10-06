-- Run once in Supabase → SQL Editor.
-- Stores every "Request a Free Estimate" submission from the website.

create table if not exists public.estimate_requests (
  id              uuid primary key default gen_random_uuid(),
  created_at      timestamptz not null default now(),
  first_name      text not null,
  last_name       text not null,
  email           text not null,
  phone           text not null,
  address         text not null,
  city            text not null,
  state           text not null,
  zip             text not null,
  services        text[] not null,
  preferred_day   date,
  preferred_time  text,
  details         text,
  photo_names     text[] not null default '{}',
  language        text not null default 'en',
  status          text not null default 'new'   -- new / contacted / scheduled / closed
);

create index if not exists estimate_requests_created_at_idx on public.estimate_requests (created_at desc);

-- Lock the table: the website never reads it directly.
-- Only the server function (service_role key) can insert, which bypasses RLS.
alter table public.estimate_requests enable row level security;
