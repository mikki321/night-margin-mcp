# Loom script — night-margin-mcp (2:30)

Submission video for the Wheelhouse Revenue Hackathon. Category: **Best Build from a Property Manager**. Target length **2:30** (form allows 2–3 min — never exceed 3:00). Recorded by Miki, own voice.

Pace: ~150 words/min. Short sentences. Read numbers **off the screen** — every number quoted below is the synthetic demo output, so the script works verbatim on the zero-config fallback path. On the real portfolio, keep the sentence shape and swap in the on-screen numbers.

---

## (0:00 – 0:20) Hook

**[SCREEN: Slide 1 ("Nobody knows what a night costs to produce") + Loom camera bubble on.]**

> I run seventy-three short-term rentals in Lapland. My revenue tool optimizes gross — and it's good at it. But nobody knows what a night costs to produce. Cleaning, laundry, travel. So I built night-margin: an MCP server that prices every decision net of turnover costs, right inside Claude.

## (0:20 – 0:45) Install — under 60 seconds

**[SCREEN: Terminal. Type and run `claude mcp add margin -- npx -y night-margin-mcp`. A visible clock/stopwatch in frame. Cut (or speed up) to Claude with the three margin tools listed. This beat can be a pre-recorded clip.]**

> Install is one command: claude mcp add margin. No config — it ships with a synthetic demo portfolio, so anyone can try it and get a first answer in under a minute. Add your Wheelhouse API key, and the same tools run on your real bookings, live from the Wheelhouse RM API. Here it is on my portfolio.

## (0:45 – 1:15) analyze_portfolio — the leak, first

**[SCREEN: Claude. Prompt: "Where is my portfolio leaking money in June 2026?" — the date is required: without it the tool defaults to last 30 + next 90 days and shows €381 / 24 bookings / €76.6, not the numbers below. Check the response header reads "Portfolio 2026-06-01 → 2026-07-01" before recording. Response scrolled to the top. Zoom/highlight the bold first line — demo reference: "**€132 is leaking from 8 bookings that don't cover their own turnover cost.** (4.0% of booked nights are net-negative)" — then "Net per available night: €74.7", then scroll to the Bottom table (Bottom 8 on demo data, Bottom 10 on a real portfolio).]**

> First question: where am I leaking money in June? analyze_portfolio pulls the bookings, attaches turnover costs, and leads with the leak: [READ THE BOLD LINE OFF SCREEN]. Revenue on paper, a loss in practice. Then the metric revenue tools don't have: net per available night. And the worst properties, ranked — that's tomorrow morning's to-do list.

## (1:15 – 1:45) compare_strategies — gross up, net down

**[SCREEN: Claude. Prompt: "Compare two strategies for June 2026: (A) fill gap nights at a 40% discount and (B) raise the minimum stay to three nights with a 10% price increase." Show the scenario table; highlight row A (Gross €26,797 / Net €17,487 / Occupancy 99.2%) against Baseline (€22,821 / €17,921 / 72.9%). End zoomed on the summary line: "A brings €3,977 more gross but €433 less net — gross-optimizing fill is a net loss."]**

> Now the trap every gross-optimizer walks into. Compare two strategies for June: A — fill every gap night at forty percent off. B — minimum stay three nights, prices up ten percent. A looks great: occupancy jumps to ninety-nine percent, gross up almost four thousand euros. But net is down four hundred and thirty-three. Gross up, net down. Because a two-night and a seven-night booking consume exactly the same cleaning.

## (1:45 – 2:05) gap_night_check + heatmap flash

**[SCREEN: Claude. Prompt: "Property demo-1br-01 has a gap night on 2026-06-23. Is it worth filling at €79?" Verdict line — demo reference: "Floor €95 (turnover 70 + travel 0 + margin 25) · candidate price €79 → SKIP — filling yields -€16." Then a 3-second cut to the /web heatmap at https://mikki321.github.io/night-margin-mcp/ — KPI tiles + red/green property grid.]**

> For a single night, gap_night_check. It computes a floor — turnover plus travel plus minimum margin — and a verdict. Seventy-nine euros for this night? Skip: filling loses sixteen euros. The whole portfolio on one heatmap — red means the calendar looks busy but the nights lose money.

## (2:05 – 2:20) Decision loop — pick ONE version

### Version A — 0.3.0 shipped (use if propose/apply/revert are live)

**[SCREEN: Claude. propose_decisions output (a short list of drafted price changes), then apply_decision with the dry-run → confirm step, then the revert command. Fast cuts, no dead air.]**

> It doesn't stop at analysis. propose_decisions drafts the price changes. apply_decision writes them to Wheelhouse for real — dry-run, then confirm. Change my mind? Revert. See the leak, fix the leak, same conversation.

### Version B — "coming next" (use if 0.3.0 is not demo-ready)

**[SCREEN: Slide 4 (roadmap + install). No live product shown for this beat.]**

> Next up — already in the works: the decision loop. propose_decisions drafts price changes, apply_decision writes them back to Wheelhouse — dry-run, confirm, revert. From seeing the leak to fixing it — same conversation.

## (2:20 – 2:30) Close

**[SCREEN: Slide 4 (or hold it from Version B): positioning line + install command + GitHub/demo links.]**

> night-margin is built by a property manager who runs seventy-three listings in Lapland — for operators like us. It's on npm today: claude mcp add margin.

---

## Production notes

1. **Data safety (decision P7).** Real listing names and revenue figures on screen ONLY with Miki's explicit sign-off. Fallback: record beats 0:45–2:05 on the zero-config synthetic demo — this script needs no rewording for it (all quoted numbers ARE the demo numbers, window 2026-06-01 → 2026-07-01 — which is why every prompt pins June 2026: an undated analyze prompt falls back to the default window and shows €381 / 24 bookings instead). Never show guest names, reservation codes, or the API key (check the terminal scrollback and shell history before recording).
2. **Pre-run the prompts.** Run all three prompts in the Claude session before recording and scroll back during the take — the 73-listing live fetch is serial (60 req/min rate limit) and too slow to wait for on camera. The install beat is the only one recorded as a fresh run.
3. **Dry-run with a stopwatch** at least once end-to-end. Beat timestamps are cue points, not hard cuts; if over 2:50, cut the heatmap flash first, then the gap_night_check beat (per LEAD cut order — never the install or compare beats).
4. **Setup:** terminal and Claude font size up (readable at 720p), notifications off, clean browser profile for the heatmap tab, Loom camera bubble bottom-right and small during screen beats.
5. **One number rule:** if a spoken number and the on-screen number ever disagree, the screen wins — re-record the sentence reading it off the screen.
