-- QR warehouse claims
create table if not exists public.qr_claims (
  id uuid primary key default gen_random_uuid(),
  wp_qr_id bigint not null unique,
  wp_title text not null,
  wp_slug text,
  serial text,
  image_url text,
  store text not null,
  claimed_by uuid references auth.users(id) on delete set null,
  employee_name text,
  claimed_at timestamptz not null default now()
);
create index if not exists qr_claims_store_idx on public.qr_claims (store);
create index if not exists qr_claims_claimed_at_idx on public.qr_claims (claimed_at desc);
alter table public.qr_claims enable row level security;
drop policy if exists "qr_claims_staff_read" on public.qr_claims;
create policy "qr_claims_staff_read" on public.qr_claims for select to authenticated using (
  exists (select 1 from public.profiles p where p.id = auth.uid() and (p.role = 'admin' or (p.role = 'staff' and p.store = qr_claims.store)))
);
