-- Reading recipes from photos (TYL-52) uses Google Cloud Vision, which is
-- free for 1,000 pages a month and paid after. Every read is counted here,
-- and the API stops short of the free tier for everyone, and of a daily
-- amount per user. Photos aren't kept: only how many pages, when, and whose.

create table public.photo_reads (
  id bigint generated always as identity primary key,
  user_id uuid not null references auth.users on delete cascade,
  pages integer not null check (pages between 1 and 4),
  read_at timestamptz not null default now()
);

create index photo_reads_user_time on public.photo_reads (user_id, read_at);
create index photo_reads_time on public.photo_reads (read_at);

-- Written and read by the API only: row-level security with no policies.
alter table public.photo_reads enable row level security;

-- Record a read of p_pages pages for p_user if it stays within both limits:
-- p_month_cap pages for everyone this calendar month (UTC, like Google's
-- billing), and p_day_cap pages for this user in the last 24 hours. Returns
-- false, recording nothing, when it wouldn't. One read at a time, so two
-- at once can't both slip under a limit.
create function public.record_photo_read(
  p_user uuid, p_pages integer, p_month_cap integer, p_day_cap integer
) returns boolean
language plpgsql as $$
begin
  if current_user not in ('service_role', 'postgres') then
    raise exception 'record_photo_read is only callable by the API' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtext('photo_reads'));
  if (select coalesce(sum(pages), 0) from public.photo_reads
      where read_at >= date_trunc('month', now() at time zone 'utc') at time zone 'utc')
     + p_pages > p_month_cap
  or (select coalesce(sum(pages), 0) from public.photo_reads
      where user_id = p_user and read_at > now() - interval '24 hours')
     + p_pages > p_day_cap then
    return false;
  end if;
  insert into public.photo_reads (user_id, pages) values (p_user, p_pages);
  return true;
end
$$;

revoke execute on function public.record_photo_read(uuid, integer, integer, integer)
  from public, anon, authenticated;
grant execute on function public.record_photo_read(uuid, integer, integer, integer)
  to service_role;
