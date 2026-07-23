# Video slides — night-margin-mcp (max 4)

Final copy for the four slides used in the Loom video (see `docs/video-script.md` for when each slide is on screen: slide 1 at 0:00, slide 2 optional under the install beat, slide 3 as a still if the compare table needs reinforcing, slide 4 at 2:05/2:20).

---

## Slide 1 — Hook (0:00)

**Nobody knows what a night costs to produce**

- I run 73 short-term rentals in Lapland. My revenue tool optimizes gross.
- Revenue tools see ADR, RevPAR, occupancy — not cleaning, laundry, travel.
- A 2-night and a 7-night booking consume the same cleaning.
- The missing metric: **net per available night** — night-margin is the margin guard that protects it.

---

## Slide 2 — What we built

**night-margin-mcp — every pricing decision, net of turnover costs**

- Eight MCP tools in Claude: three analyses (`analyze_portfolio` · `compare_strategies` · `gap_night_check`), the decision loop (`propose_decisions` → `apply_decision` → `revert_decision`), monthly targets, and `check_alerts`
- Live bookings from the **Wheelhouse RM API** — tested on a real 73-listing portfolio
- Turnover costs from your own operation: flat average, per-type tiers, or per-booking CSV
- Zero config → first answer in under 60 seconds (synthetic demo portfolio built in)

Architecture (the one picture):

```
   You ask                 The math                     The data
  ┌────────┐   MCP    ┌─────────────────┐   HTTPS   ┌────────────────────┐
  │ Claude │ ◄──────► │ night-margin-mcp │ ◄───────► │  Wheelhouse RM API │
  └────────┘          │  net / available │           │ listings · reserva-│
                      │      night       │           │ tions · price recs │
                      └────────▲─────────┘           └────────────────────┘
                               │
                 cost sources: manual € avg │ tiers │ CSV per booking │ ops-platform API
```

---

## Slide 3 — The money slide

**Gross up €18,009. Net down €1,801.**

Demo portfolio, default window — same bookings, three strategies:

| Strategy | Gross | Net | Net/night | Occupancy |
|---|---:|---:|---:|---:|
| Baseline | €93,691 | €73,601 | €76.7 | 70.3% |
| A: fill gap nights at 40% off | **€111,699** | **€71,799** | €74.8 | 99.8% |
| B: min stay 3 nights, prices +10% | €73,040 | €65,760 | €68.5 | 44.5% |

- Strategy A: occupancy 99.8%, a revenue record — and **less profit than doing nothing**.
- The tool says it in one line: *"gross-optimizing fill is a net loss."*

---

## Slide 4 — Roadmap + install (2:05 / 2:20)

**Install it today**

*Wheelhouse optimizes what guests pay. night-margin protects what you keep.*

```
claude mcp add margin -- npx -y night-margin-mcp
```

- Works instantly on demo data — add `WHEELHOUSE_API_KEY` to run your own portfolio.
- **New in 0.3.0:** the decision loop — `propose_decisions` → `apply_decision` (writes prices to Wheelhouse: dry-run · confirm · revert) → `revert_decision`, plus monthly net targets.
- **Built by a property manager who runs 73 listings in Lapland — for operators like us.**
- github.com/mikki321/night-margin-mcp · live demo: mikki321.github.io/night-margin-mcp


