-- Bug reports (beta): feedback can be a problem or an idea. A problem comes
-- with the device it happened on and a link to the PostHog replay of the
-- session; the API files it in Linear and records where.

alter table public.feedback
  add column kind text not null default 'idea' check (kind in ('problem', 'idea')),
  -- Browser and phone, as the browser describes itself.
  add column device text check (length(device) <= 300),
  add column replay_url text check (replay_url ~ '^https://[a-z]+\.posthog\.com/'),
  -- Set by the API once the problem is filed in Linear.
  add column linear_url text;

-- Users can't claim a report was filed: only the API sets linear_url.
create function public.feedback_from_users() returns trigger
language plpgsql as $$
begin
  if current_user not in ('service_role', 'postgres') then
    new.linear_url := null;
  end if;
  return new;
end
$$;

create trigger feedback_from_users before insert on public.feedback
  for each row execute function public.feedback_from_users();
