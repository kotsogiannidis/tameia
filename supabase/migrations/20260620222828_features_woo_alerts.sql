-- ConnectPhone ΤΑΜΕΙΑ — Live widget, Woo health, Smart alerts, Realtime
-- Apply via Supabase SQL editor or: supabase db push

begin;

-- ── Woo sync log (health panel + failed sync alerts) ─────────────────────────
create table if not exists public.woo_sync_log (
  id uuid primary key default gen_random_uuid(),
  ok boolean not null default true,
  error_message text,
  orders_synced int not null default 0,
  unmapped_skus text[] not null default '{}',
  dates_affected date[] not null default '{}',
  created_at timestamptz not null default now()
);
alter table public.woo_sync_log enable row level security;
drop policy if exists woo_sync_log_read on public.woo_sync_log;
create policy woo_sync_log_read on public.woo_sync_log
  for select to authenticated using (auth_role() in ('admin', 'hr'));

-- ── Smart alerts ────────────────────────────────────────────────────────────
create table if not exists public.alerts (
  id uuid primary key default gen_random_uuid(),
  alert_type text not null,
  severity text not null default 'warning',
  store text,
  title text not null,
  body text,
  meta jsonb not null default '{}',
  created_at timestamptz not null default now(),
  read_at timestamptz,
  dismissed_at timestamptz
);
create index if not exists alerts_active_idx on public.alerts (created_at desc)
  where dismissed_at is null;
alter table public.alerts enable row level security;
drop policy if exists alerts_admin on public.alerts;
create policy alerts_admin on public.alerts
  for all to authenticated
  using (auth_role() = 'admin')
  with check (auth_role() = 'admin');

-- ── Stock thresholds (low-stock alerts) ─────────────────────────────────────
create table if not exists public.stock_thresholds (
  store text not null,
  product text not null,
  min_qty int not null default 5,
  primary key (store, product)
);
alter table public.stock_thresholds enable row level security;
drop policy if exists stock_thresholds_read on public.stock_thresholds;
create policy stock_thresholds_read on public.stock_thresholds
  for select to authenticated using (auth_role() in ('admin', 'warehouse', 'hr'));
drop policy if exists stock_thresholds_admin on public.stock_thresholds;
create policy stock_thresholds_admin on public.stock_thresholds
  for all to authenticated
  using (auth_role() = 'admin')
  with check (auth_role() = 'admin');

insert into public.stock_thresholds (store, product, min_qty)
select distinct s.store, s.product, 5 from public.stock s
on conflict (store, product) do nothing;

-- ── Realtime publication ──────────────────────────────────────────────────────
do $$ begin
  alter publication supabase_realtime add table public.sales;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.cashreg;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.deposits;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.expenses;
exception when duplicate_object then null; end $$;
do $$ begin
  alter publication supabase_realtime add table public.alerts;
exception when duplicate_object then null; end $$;

-- ── Helper: days since last deposit per store ─────────────────────────────────
create or replace function public.store_cash_available(p_store text)
returns numeric language sql stable as $$
  select coalesce((
    select sum((t.cash)::numeric)
    from public.sales s, lateral public.sales_totals(s) t
    where s.store = p_store
  ), 0)
  - coalesce((select sum(amount) from public.deposits where store = p_store), 0)
  - coalesce((select sum(amount) from public.expenses where store = p_store), 0);
$$;

create or replace function public.days_since_last_deposit(p_store text)
returns int language sql stable as $$
  select coalesce(
    extract(day from now() - max(created_at))::int,
    999
  ) from public.deposits where store = p_store;
$$;

commit;

-- Optional: pg_cron every 30 min (enable pg_cron extension first)
-- select cron.schedule('check-alerts', '*/30 * * * *',
--   $$select net.http_post(
--     url := 'https://stbmppnyngfkbvgoajuf.supabase.co/functions/v1/check-alerts',
--     headers := jsonb_build_object('Authorization', 'Bearer ' || current_setting('app.settings.service_role_key')),
--     body := '{}'::jsonb
--   );$$);
