# Supabase setup

This storefront uses the Supabase browser client for account sign-up/sign-in,
product listings, per-account carts and wishlists, and order storage.

1. Create a Supabase project and open **SQL Editor**.
2. Run [`supabase/schema.sql`](./supabase/schema.sql). This creates the tables,
   row-level security policies, account profile trigger, order RPC, and sample
   products based on the images in this project.
3. In **Project Settings → API**, copy the project URL and the public
   anon/publishable key into [`supabase-config.js`](./supabase-config.js).
   That public key is intended for browser use; never use a service-role key.
4. Serve this folder through a local web server (not `file://`), for example
   with VS Code Live Server or by running `py -m http.server 5500` from this
   folder and opening `http://localhost:5500`. Product data and account
   features need the configured project.
5. In **Authentication → URL Configuration**, set the Site URL to your
   deployed HTTPS origin (for example, `https://your-store.example`) and add
   that origin plus `/**` to the redirect URL allow-list. Keep
   `http://localhost:5500/**` in the allow-list for local development. These
   redirects are used for signup confirmation and password recovery.
6. This project currently has **Confirm email disabled**, so new accounts can
   sign in immediately after signup. For a public production store, consider
   enabling it after configuring a trusted SMTP provider in
   **Authentication → Email Templates / SMTP Settings**. If enabled, customers
   must confirm their email before signing in; the store can resend confirmation
   and password reset emails.

## Email confirmation

To allow new accounts to sign in immediately after registration, open
**Authentication → Sign In / Providers → Email** and turn off **Confirm email**.
This is a Supabase project setting; changing browser code cannot bypass it.
Existing accounts created while confirmation was required may still need their
status updated in **Authentication → Users**.

## Before deploying

- Set the production Site URL and redirect allow-list as described above.
- Use HTTPS for the deployed storefront.
- The browser config must contain only the project's public anon/publishable
  key; never put a service-role key in the site.
- Checkout currently records cash-on-delivery orders only. Online card payments
  are not enabled.

## What is stored

- Supabase Auth manages passwords and sessions. `profiles` stores a display
  name and email, not a password.
- `products` is publicly readable for active listings; manage catalog rows
  through the Supabase dashboard or a trusted server.
- Signed-in users can access only their own cart, wishlist, and orders.
- `place_order` recalculates prices from the catalog, checks stock, records
  shipping details and line-item snapshots, decreases stock, and empties the
  user's cart in one database transaction.

Checkout currently records orders as **unpaid/pending** with cash on delivery.
The existing browser-only card form and exposed payment-key flow are not a
secure payment integration, so this version does not collect or store card
numbers. Add a server-side payment provider integration and verified webhook
before enabling online payments.
