# ConnectPhone Tameia (Ταμεία)

**EN:** Store-facing POS / cash-register web app for ConnectPhone retail locations. Static single-page app (no build step) with Supabase Auth, real-time data, and Edge Functions for WooCommerce sync, alerts, admin settings, warehouse QR flows, and package photo scanning.

**EL:** Εφαρμογή ταμείου για καταστήματα ConnectPhone. SPA χωρίς build, με Supabase για σύνδεση χρηστών, δεδομένα και Edge Functions.

## Structure

```
tameia/
  index.html              # Main POS UI
  manifest.webmanifest    # PWA manifest
  sw.js                   # Service worker
  netlify.toml            # Netlify headers & SPA redirects
  supabase/
    migrations/             # SQL migrations (Woo, alerts, QR claims)
    functions/
      woo-sync/             # WooCommerce synchronization
      check-alerts/         # Alert checks / notifications
      admin-settings/       # Admin configuration API
      qr-warehouse/         # Warehouse QR claim flows
      scan-package-photo/   # Package photo scan handling
```

## Deploy

### Netlify (frontend)

1. Connect this repo to [Netlify](https://www.netlify.com/) (or drag-and-drop the folder).
2. Build settings: **publish directory** = `.` (root); no build command.
3. `netlify.toml` sets security headers and SPA fallback to `index.html`.

### Supabase (backend)

1. Install [Supabase CLI](https://supabase.com/docs/guides/cli) and link the project: `supabase link --project-ref <your-ref>`.
2. Apply migrations: `supabase db push` (or run SQL from `supabase/migrations/` in order).
3. Deploy Edge Functions:
   ```bash
   supabase functions deploy woo-sync
   supabase functions deploy check-alerts
   supabase functions deploy admin-settings
   supabase functions deploy qr-warehouse
   supabase functions deploy scan-package-photo
   ```
4. Set required secrets (WooCommerce, etc.) in the Supabase dashboard or via `supabase secrets set`.

Configure the Supabase URL and anon key in the frontend (environment or embedded config as used in `index.html`).

## Local notes

- Do not commit `.env` or Netlify local state (see `.gitignore`).
