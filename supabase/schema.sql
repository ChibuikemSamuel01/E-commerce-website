create extension if not exists pgcrypto;

create table if not exists public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  email text,
  full_name text not null default '',
  created_at timestamptz not null default now()
);

create table if not exists public.products (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  description text not null default '',
  category text not null,
  price numeric(12, 2) not null check (price >= 0),
  image_url text not null default '',
  stock integer not null default 0 check (stock >= 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.cart_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  quantity integer not null check (quantity between 1 and 99),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table if not exists public.wishlist_items (
  user_id uuid not null references auth.users (id) on delete cascade,
  product_id uuid not null references public.products (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, product_id)
);

create table if not exists public.orders (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending', 'processing', 'shipped', 'delivered', 'cancelled')),
  payment_status text not null default 'unpaid'
    check (payment_status in ('unpaid', 'paid', 'refunded')),
  payment_method text not null default 'cash_on_delivery'
    check (payment_method in ('cash_on_delivery')),
  subtotal numeric(12, 2) not null check (subtotal >= 0),
  shipping_address jsonb not null,
  created_at timestamptz not null default now()
);

create table if not exists public.order_items (
  id uuid primary key default gen_random_uuid(),
  order_id uuid not null references public.orders (id) on delete cascade,
  product_id uuid references public.products (id) on delete set null,
  product_name text not null,
  unit_price numeric(12, 2) not null check (unit_price >= 0),
  quantity integer not null check (quantity between 1 and 99)
);

create index if not exists products_category_active_idx
  on public.products (category, active);
create index if not exists orders_user_created_idx
  on public.orders (user_id, created_at desc);
create index if not exists order_items_order_idx
  on public.order_items (order_id);

alter table public.profiles enable row level security;
alter table public.products enable row level security;
alter table public.cart_items enable row level security;
alter table public.wishlist_items enable row level security;
alter table public.orders enable row level security;
alter table public.order_items enable row level security;

grant select on public.products to anon, authenticated;
grant select, update on public.profiles to authenticated;
grant select, insert, update, delete on public.cart_items to authenticated;
grant select, insert, delete on public.wishlist_items to authenticated;
grant select on public.orders, public.order_items to authenticated;

drop policy if exists "Profiles are readable by their owner" on public.profiles;
create policy "Profiles are readable by their owner"
  on public.profiles for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists "Profiles are editable by their owner" on public.profiles;
create policy "Profiles are editable by their owner"
  on public.profiles for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

drop policy if exists "Active products are public" on public.products;
create policy "Active products are public"
  on public.products for select to anon, authenticated
  using (active = true);

drop policy if exists "Users manage their own cart" on public.cart_items;
create policy "Users manage their own cart"
  on public.cart_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users manage their own wishlist" on public.wishlist_items;
create policy "Users manage their own wishlist"
  on public.wishlist_items for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists "Users read their own orders" on public.orders;
create policy "Users read their own orders"
  on public.orders for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists "Users read their own order items" on public.order_items;
create policy "Users read their own order items"
  on public.order_items for select to authenticated
  using (
    exists (
      select 1 from public.orders
      where orders.id = order_items.order_id
        and orders.user_id = (select auth.uid())
    )
  );

create or replace function public.create_profile_for_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (
    new.id,
    new.email,
    coalesce(new.raw_user_meta_data ->> 'full_name', '')
  )
  on conflict (id) do update
    set email = excluded.email;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute procedure public.create_profile_for_new_user();

create or replace function public.place_order(p_shipping_address jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_order_id uuid;
  v_subtotal numeric(12, 2) := 0;
  v_item record;
  v_item_count integer := 0;
begin
  if v_user_id is null then
    raise exception 'Sign in before placing an order';
  end if;

  if jsonb_typeof(p_shipping_address) <> 'object'
     or coalesce(trim(p_shipping_address ->> 'first-name'), '') = ''
     or coalesce(trim(p_shipping_address ->> 'last-name'), '') = ''
     or coalesce(trim(p_shipping_address ->> 'address'), '') = ''
     or coalesce(trim(p_shipping_address ->> 'email'), '') = ''
     or coalesce(trim(p_shipping_address ->> 'tel'), '') = '' then
    raise exception 'Complete the shipping details before placing your order';
  end if;

  for v_item in
    select ci.product_id, ci.quantity, p.name, p.price, p.stock
    from public.cart_items ci
    join public.products p on p.id = ci.product_id
    where ci.user_id = v_user_id and p.active = true
    order by ci.product_id
    for update of p
  loop
    if v_item.quantity > v_item.stock then
      raise exception 'Not enough stock for %', v_item.name;
    end if;
    v_item_count := v_item_count + 1;
    v_subtotal := v_subtotal + (v_item.price * v_item.quantity);
  end loop;

  if v_item_count = 0 then
    raise exception 'Your cart is empty or contains unavailable products';
  end if;

  insert into public.orders (user_id, subtotal, shipping_address)
  values (v_user_id, v_subtotal, p_shipping_address)
  returning id into v_order_id;

  for v_item in
    select ci.product_id, ci.quantity, p.name, p.price
    from public.cart_items ci
    join public.products p on p.id = ci.product_id
    where ci.user_id = v_user_id and p.active = true
    order by ci.product_id
    for update of p
  loop
    insert into public.order_items (
      order_id, product_id, product_name, unit_price, quantity
    )
    values (
      v_order_id, v_item.product_id, v_item.name, v_item.price, v_item.quantity
    );

    update public.products
      set stock = stock - v_item.quantity, updated_at = now()
      where id = v_item.product_id;
  end loop;

  delete from public.cart_items where user_id = v_user_id;
  return v_order_id;
end;
$$;

revoke all on function public.place_order(jsonb) from public;
grant execute on function public.place_order(jsonb) to authenticated;

insert into public.products (slug, name, description, category, price, image_url, stock)
values
  ('macbook-pro-16', 'MacBook Pro 16-inch', 'High-performance laptop for work and creative projects.', 'Laptops', 3400000, './laptopSelling.jpg', 10),
  ('ultrabook-pro', 'Ultrabook Pro', 'Lightweight laptop with all-day performance.', 'Laptops', 2150000, './laptop2.jpg', 12),
  ('everyday-laptop', 'Everyday Laptop', 'Reliable laptop for school, work, and everyday use.', 'Laptops', 1250000, './laptop.jpg', 16),
  ('smartphone-pro', 'Smartphone Pro', 'Premium smartphone with a vivid display and fast camera.', 'Phones', 980000, './sellingPhone.jpg', 15),
  ('smartphone-plus', 'Smartphone Plus', 'Large-screen smartphone with dependable battery life.', 'Phones', 720000, './phone.jpg', 20),
  ('compact-smartphone', 'Compact Smartphone', 'Compact phone with modern performance.', 'Phones', 540000, './bigphone.jpg', 18),
  ('tablet-pro', 'Tablet Pro', 'Versatile tablet for creating, studying, and streaming.', 'Tablets', 650000, './sellingGadget.jpg', 12),
  ('everyday-tablet', 'Everyday Tablet', 'Portable tablet for home and on-the-go use.', 'Tablets', 420000, './tablet.jpg', 18),
  ('large-screen-tablet', 'Large Screen Tablet', 'Large display tablet for entertainment and productivity.', 'Tablets', 790000, './bigTablets.jpg', 9),
  ('wireless-accessories-kit', 'Wireless Accessories Kit', 'Essential wireless accessories for your workspace.', 'Accessories', 95000, './sellingAccesories.jpg', 30),
  ('accessory-essentials', 'Accessory Essentials', 'Everyday tech accessories in one convenient kit.', 'Accessories', 65000, './accesoory.jpg', 40),
  ('premium-accessory', 'Premium Accessory', 'A premium add-on for your favorite devices.', 'Accessories', 125000, './bigAccesories.jpg', 22)
on conflict (slug) do update set
  name = excluded.name,
  description = excluded.description,
  category = excluded.category,
  price = excluded.price,
  image_url = excluded.image_url,
  updated_at = now();
