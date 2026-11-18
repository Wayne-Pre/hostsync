-- 009_reviews.sql — F-56…F-61 (Stage 2 reviews)
--
-- A review that was answered is not the same as a review nobody replied to, so
-- the reply and its timestamp live on the review itself. Review *requests* are
-- their own rows: asking twice is a mistake the host must be able to see.

alter table review add column if not exists replied_at timestamptz;
alter table review add column if not exists reply_body text;

create table if not exists review_request (
  id           uuid primary key default gen_random_uuid(),
  portfolio_id uuid not null references portfolio(id) on delete cascade,
  property_id  uuid references property(id) on delete set null,
  booking_id   uuid references booking(id) on delete cascade,
  guest_name   text not null,
  channel      text not null,
  requested_at timestamptz not null default now(),
  unique (booking_id)
);

create index if not exists review_request_portfolio_idx on review_request (portfolio_id, requested_at desc);

alter table portfolio add column if not exists auto_review_request boolean not null default false;
alter table portfolio add column if not exists review_request_days int not null default 1
  check (review_request_days between 0 and 30);
