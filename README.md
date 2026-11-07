# Sacramento Infrastructure Map

A React + Vite prototype that brings City of Sacramento repair records and community-submitted street issues together on one map.

## Run it

1. Install [Node.js](https://nodejs.org/) if it is not already installed.
2. Open this folder in VS Code.
3. Open **Terminal → New Terminal** and run:

   ```sh
   npm install
   npm run dev
   ```

4. Open the local URL Vite prints in the terminal.

The map and public City records work without API keys. Until Supabase is configured, community reports are stored in the current browser's local storage and survive a page refresh on that device. Browser-local reports can be permanently deleted from **My Reports**; deletion is unavailable for Supabase reports until report ownership is configured.

## What is on the map

- The public source is the [City of Sacramento 311 Repairs ArcGIS service](https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/311_Repairs_WFL1/FeatureServer). Its public layers contain pothole repairs and street-light fixes.
- To keep the map responsive, it loads the 100 most recently updated records from each City layer, caches them in this browser for 30 minutes, and draws report markers on a canvas.
- These are repair records, not a feed of current open work orders. The prototype presents them as resolved City records and does not submit reports to the City.
- The basemap uses CARTO's Voyager tiles with your CARTO Basemaps key when configured; without a key, it falls back to CARTO's public light tiles.
- On opening the map, your browser asks whether to share your location. If allowed, the map centers on you and shows loaded reports within 5 km; if denied, Sacramento remains the default map location. You can change the nearby filter at any time. The map only searches reports currently loaded by the prototype.
- Use the issue-type checkboxes to show or hide each category. Filter by type, source, status, or time (any time, the last 90 days, or a custom date range). Click **Report an issue**, click a location on the map, fill out the form, and submit.

## Use Supabase (optional)

Create a free Supabase project, open its SQL Editor, and run:

If you already created the `reports` table using an earlier version of this guide, run the confirmation migration statements starting at `alter table public.reports` instead.

```sql
create table public.reports (
  id uuid primary key default gen_random_uuid(),
  created_at timestamptz not null default now(),
  issue_type text not null check (issue_type in ('pothole', 'streetlight', 'construction', 'sidewalk')),
  description text not null check (char_length(description) between 5 and 500),
  severity text not null check (severity in ('low', 'medium', 'high')),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  status text not null default 'open' check (status in ('open', 'in-progress', 'resolved')),
  source text not null default 'user' check (source in ('user', 'city-of-sacramento')),
  confirmation_count integer not null default 0 check (confirmation_count >= 0),
  external_id text unique
);

alter table public.reports enable row level security;

create policy "Anyone can read reports"
  on public.reports for select
  using (true);

create policy "Anyone can add community reports"
  on public.reports for insert
  with check (source = 'user');

alter table public.reports
  add column if not exists confirmation_count integer not null default 0 check (confirmation_count >= 0);

create table if not exists public.report_confirmations (
  report_id uuid not null references public.reports(id) on delete cascade,
  confirmer_id text not null,
  created_at timestamptz not null default now(),
  primary key (report_id, confirmer_id)
);

alter table public.report_confirmations enable row level security;

drop policy if exists "Anyone can confirm community reports" on public.report_confirmations;
create policy "Anyone can confirm community reports"
  on public.report_confirmations for insert
  with check (
    length(trim(confirmer_id)) > 0 and
    exists (
      select 1 from public.reports
      where reports.id = report_id and reports.source = 'user'
    )
  );

create or replace function public.increment_report_confirmation_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.reports
  set confirmation_count = confirmation_count + 1
  where id = new.report_id;
  return new;
end;
$$;

drop trigger if exists report_confirmation_inserted on public.report_confirmations;
create trigger report_confirmation_inserted
  after insert on public.report_confirmations
  for each row execute function public.increment_report_confirmation_count();
```

Community reports are initially **Unconfirmed**. A report is shown as **Confirmed by N people** after three confirmations. Each browser installation can confirm each report once; this anonymous demo does not verify a person's identity. In local-storage mode, confirmations are only stored in that browser. Supabase is required to share confirmation counts across browsers.

In the project folder, create `.env.local` and add the **CARTO Basemaps key** you received. Add the **Project URL** and **anon/public key** too if you are connecting Supabase:

```text
VITE_CARTO_BASEMAP_KEY=your-carto-basemaps-key
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-public-anon-key
```

Restart `npm run dev` after changing environment variables. Vite exposes `VITE_` values to the browser, and a basemap key is sent to CARTO with tile requests. Restrict the key to your website's domain in CARTO and never commit `.env.local`. Never put a Supabase `service_role` key in a browser app. These open demo policies allow anyone to read and submit reports; use stronger policies and abuse prevention before a public production launch.

## Deploy to Vercel

Import this folder as its own Vercel project, use the default Vite build settings (`npm run build`, output folder `dist`), and add `VITE_CARTO_BASEMAP_KEY` and, if Supabase is enabled, the two Supabase environment variables in the Vercel project settings.
