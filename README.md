# night-margin-mcp — Margin Engine

An MCP server that shows every pricing decision for a short-term rental portfolio **net of turnover costs**. Wheelhouse optimizes gross revenue (ADR, RevPAR) — this tool tells you what it costs to *produce* a night. The key metric: **net per available night**.

## Quick start

```bash
claude mcp add margin -- npx -y night-margin-mcp
```

That's it — **works with zero config on synthetic demo data**. Open Claude and ask:

> Analyze my portfolio for June 2026 (2026-06-01 → 2026-07-01)

You'll get the leak figure, the net-per-night metric, and your best and worst properties in under a minute. When you're ready to run the analysis against *your own* Wheelhouse portfolio, see [Wheelhouse API key](#wheelhouse-api-key) below.

## Example prompts

The server provides three tools. Try these directly in Claude:

1. **`analyze_portfolio`** — where is the money leaking?
   > Analyze my portfolio for 2026-06-01 → 2026-07-01. Which properties have the weakest net per night, and how much leak comes from net-negative bookings?

2. **`compare_strategies`** — gross vs. net in the same picture:
   > Compare two strategies for June 2026: (A) fill gap nights at a 40% discount and (B) raise the minimum stay to three nights with a 10% price increase. Which one delivers the better net per night?

3. **`gap_night_check`** — is a single gap night worth filling?
   > Property demo-1br-01 has a gap night on 2026-06-23. What's the floor price, and is the night worth filling?

The core message of the demo: **filling gaps at a discount can grow revenue while shrinking profit — a 2-night and a 7-night booking consume the same cleaning.**

## Configuration (env)

Every setting is optional — without them, the server runs the manual cost model on synthetic demo data. Environment variables are passed via `claude mcp add`'s `-e` flags:

```bash
claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -e COST_SOURCE=csv -e CSV_PATH=/path/to/costs.csv -- npx -y night-margin-mcp
```

| Variable | Default | Description |
|---|---|---|
| `WHEELHOUSE_API_KEY` | – | Your own Wheelhouse integration key. When set, bookings are fetched from the Wheelhouse RM API; without it, synthetic demo data is used. |
| `COST_SOURCE` | `manual` | Source of turnover costs: `manual` \| `csv` \| `cleanhub`. |
| `AVG_TURNOVER_COST` | `70` | Manual mode: € per turnover (cleaning). Also serves as the fallback in CSV mode when a booking has no cost row. |
| `COST_TIERS` | – | Optional tiering, e.g. `1br:55,2br:70,3br:95` — matched against the property's `property_id` by substring; everything else gets `AVG_TURNOVER_COST`. |
| `CSV_PATH` | – | CSV mode: path to the cost CSV (required when `COST_SOURCE=csv`). See [CSV mode](#csv-mode). |
| `CLEANHUB_API_URL` / `CLEANHUB_TOKEN` | – | CleanHub mode: actual turnover costs from the CleanHub field-operations platform over HTTP (both required when `COST_SOURCE=cleanhub`). |
| `MIN_MARGIN` | `25` | Minimum margin € for the gap-night floor: floor = turnover + travel + `MIN_MARGIN`. Used in `gap_night_check`'s fill/skip verdict. |

## CSV mode

If you know your actual turnover costs per booking, a CSV gives you the most accurate analysis. Schema (header row required):

```
reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday
demo-1br-01-r1,demo-1br-01,2026-06-03,2026-06-10,7,571,56,16,9,2026-06-10,false
```

A synthetic sample file (887 rows, covering the full 2026 calendar year of the demo data) ships with the package at `examples/sample-costs.csv`, and can be downloaded directly:

```
https://raw.githubusercontent.com/<GITHUB_USER>/night-margin-mcp/main/examples/sample-costs.csv
```

> Note: this link will be updated to the final address once the repo is published on GitHub.

Usage:

```bash
curl -o costs.csv "https://raw.githubusercontent.com/<GITHUB_USER>/night-margin-mcp/main/examples/sample-costs.csv"
claude mcp add margin -e COST_SOURCE=csv -e CSV_PATH="$PWD/costs.csv" -- npx -y night-margin-mcp
```

Cost rows are matched to bookings primarily by `reservation_id`, and secondarily by the composite key `property_id|checkin|checkout`. The tool response reports the attribution quality (e.g. "Cost attribution: 41 by id, 6 by composite key, 3 by average"). If a row is missing and no `AVG_TURNOVER_COST` fallback is set, you get a clear error listing the affected bookings.

## Wheelhouse API key

Without a key, the server runs on synthetic demo data (and says so in every response). With a key, you get **your real bookings** from the Wheelhouse RM API: the server fetches your listings and reservations, and every metric is computed from your own portfolio.

- The key is your own Wheelhouse integration key (the API's `X-Integration-Api-Key` header). Get it from your Wheelhouse account's integration settings or from Wheelhouse support — API documentation: <https://api.usewheelhouse.com/wheelhouse_rm_api>.
- Pass it as an environment variable: `claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -- npx -y night-margin-mcp`.
- **Never commit the key to git** — not in a `.env` file in the repo, not in README examples, not in commits. The key travels only as an environment variable.

If the key is invalid or the network flakes, the server returns a clear error with instructions — it does **not** silently fall back to demo data, so you'll never mistake mock numbers for your own.

## For developers

Local development:

```bash
npm install
npm test
npm run build
claude mcp add margin -- node "<repo path>/dist/index.js"
```

If the npm package doesn't work for any reason, the same server installs directly from GitHub:

```bash
claude mcp add margin -- npx -y github:<GITHUB_USER>/night-margin-mcp
```

### Exploring the Wheelhouse API with curl

Use these commands to verify auth and inspect response shapes (redact guest names/emails before sharing; field names and formats are preserved):

```bash
# 1) Listings — confirms auth + provides listing_id and channel
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings?per_page=5&page=1" | head -c 4000

# 2) Reservations — THE blocking one (full JSON for 2–3 reservations)
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/reservations?channel=<CHANNEL>" | head -c 6000

# 3) Price recommendations — for gap_night_check, lower priority
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/price_recommendations?channel=<CHANNEL>" | head -c 4000
```

The rate limit is 60 requests/min — the server runs requests serially and backs off on 429 responses (2 s / 4 s / 8 s).

## Core math

```
net_per_night  = (gross − cleaning − laundry − travel) / available nights
available      = booked nights + gap nights in the analysis window
gap_floor      = turnover cost + travel + MIN_MARGIN
leak           = Σ(€ of net-negative bookings) and % of booked nights
```

All data shipped with the repo and the package is synthetic — no real customer or property data is included.
