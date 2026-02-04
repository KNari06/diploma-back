create table if not exists public.stripe_transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  stripe_customer_id text not null,
  stripe_invoice_id text not null unique,
  stripe_event_id text unique,
  stripe_subscription_id text,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_price_id text,
  amount integer not null, -- in cents
  currency text not null,
  status text not null default 'succeeded',
  created_at timestamptz not null default now()
);
