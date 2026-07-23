# Loom script — night-margin-mcp (2:30)

Submission video for the Wheelhouse Revenue Hackathon. Category: **Best Build from a Property Manager**. Target length **2:30** (form allows 2–3 min — never exceed 3:00). Recorded by Miki, own voice.

Pace: ~150 words/min. Short sentences. Read numbers **off the screen** — every number quoted below is the synthetic demo output, so the script works verbatim on the zero-config fallback path. On the real portfolio, keep the sentence shape and swap in the on-screen numbers.

---

## (0:00 – 0:20) Hook

**[SCREEN: Slide 1 ("Nobody knows what a night costs to produce") + Loom camera bubble on.]**

> I run seventy-three short-term rentals in Lapland. My revenue tool optimizes gross — and it's good at it. But nobody knows what a night costs to produce. Cleaning, laundry, travel. When that cost is a quarter of a cheap night's revenue, filling the calendar can lose you money. So I built night-margin — the margin guard that nets every decision against turnover cost, right inside Claude. It even tells you when the answer is "do nothing" — and means it.

## (0:20 – 0:45) Install — under 60 seconds

**[SCREEN: Terminal. Type and run `claude mcp add margin -- npx -y night-margin-mcp`. A visible clock/stopwatch in frame. Cut (or speed up) to Claude with the nine margin tools listed. This beat can be a pre-recorded clip.]**

> Install is one command: claude mcp add margin. No config — it ships with a synthetic demo portfolio, so anyone can try it and get a first answer in under a minute. Add your Wheelhouse API key, and the same tools run on your real bookings, live from the Wheelhouse RM API. Here it is on my portfolio.

## (0:45 – 1:15) analyze_portfolio — the leak, first

**[SCREEN: Claude. Prompt: "Where is my portfolio leaking money in June 2026?" — the date is required: without it the tool defaults to last 30 + next 90 days and shows €385 / 24 bookings / €76.7, not the numbers below. Check the response header reads "Portfolio 2026-06-01 → 2026-07-01" before recording. Response scrolled to the top. Zoom/highlight the bold first line — demo reference: "**€132 is leaking from 8 bookings that don't cover their own turnover cost.** (4.0% of booked nights are net-negative)" — then "Net per available night: €74.7", then scroll to the Bottom table (Bottom 8 on demo data, Bottom 10 on a real portfolio).]**

> First question: where am I leaking money in June? analyze_portfolio pulls the bookings, attaches turnover costs, and leads with the leak: [READ THE BOLD LINE OFF SCREEN]. Revenue on paper, a loss in practice. Then the metric revenue tools don't have: net per available night. And the worst properties, ranked — that's tomorrow morning's to-do list.

## (1:15 – 1:45) compare_strategies — gross up, net down

**[SCREEN: Claude. Prompt: "Compare two strategies for June 2026: (A) fill gap nights at a 40% discount and (B) raise the minimum stay to three nights with a 10% price increase." Show the scenario table; highlight row A (Gross €111,699 / Net €71,799 / Occupancy 99.8%) against Baseline (€93,691 / €73,601 / 70.3%). End zoomed on the summary line: "A brings €18,009 more gross but €1,801 less net — gross-optimizing fill is a net loss."]**

> Now the trap every gross-optimizer walks into. Compare two strategies for June: A — fill every gap night at forty percent off. B — minimum stay three nights, prices up ten percent. A looks great: occupancy jumps to ninety-nine point eight percent, gross up eighteen thousand euros. But net is down eighteen hundred. Gross up, net down. Because a two-night and a seven-night booking consume exactly the same cleaning.

## (1:45 – 2:05) gap_night_check + heatmap flash

**[SCREEN: Claude. Prompt: "Property demo-1br-01 has a gap night on 2026-06-23. Is it worth filling at €79?" Verdict line — demo reference: "Floor €95 (turnover 70 + travel 0 + margin 25) · candidate price €79 → SKIP — filling yields -€16." Then a 3-second cut to the /web heatmap at https://mikki321.github.io/night-margin-mcp/ — KPI tiles + red/green property grid.]**

> For a single night, gap_night_check. It computes a floor — turnover plus travel plus minimum margin — and a verdict. Seventy-nine euros for this night? Skip: filling loses sixteen euros. The whole portfolio on one heatmap — red means the calendar looks busy but the nights lose money.

## (2:05 – 2:20) Decision loop

**[SCREEN: Claude. propose_decisions output (a short list of drafted price changes), then apply_decision with the dry-run → confirm step, then the revert command. Fast cuts, no dead air.]**

> It doesn't stop at analysis. propose_decisions drafts the price changes. apply_decision writes them to Wheelhouse for real — dry-run, then confirm. Change my mind? Revert. See the leak, fix the leak, same conversation.

## (2:20 – 2:30) Close

**[SCREEN: Slide 4: positioning line + install command + GitHub/demo links.]**

> night-margin protects what you keep — built by a property manager who runs seventy-three listings in Lapland, for operators like us. It's on npm today: claude mcp add margin.

---

## Production notes

1. **Data safety (decision P7).** Real listing names and revenue figures on screen ONLY with Miki's explicit sign-off. Fallback: record beats 0:45–2:05 on the zero-config synthetic demo — this script needs no rewording for it (all quoted numbers ARE the demo numbers, window 2026-06-01 → 2026-07-01 — which is why every prompt pins June 2026: an undated analyze prompt falls back to the default window and shows €385 / 24 bookings instead). Never show guest names, reservation codes, or the API key (check the terminal scrollback and shell history before recording).
2. **Warm the caches within 10 minutes of the take.** Both caches are 10 minutes (Wheelhouse client + UI server). Run `analyze_portfolio` once and `propose_decisions` once, and pre-open the month plan, immediately before recording. Cold, a live portfolio-wide call is ~90 s and unrecordable.
3. **Record demo beats with an isolated state dir:** `NM_STATE_DIR=/tmp/nm-demo`. The decision log and monthly targets live in `~/.night-margin/` and are shared between demo and live mode.
4. **Pre-run the prompts.** Run all three prompts in the Claude session before recording and scroll back during the take — the 73-listing live fetch is serial (60 req/min rate limit) and too slow to wait for on camera. The install beat is the only one recorded as a fresh run.
5. **Dry-run with a stopwatch** at least once end-to-end. Beat timestamps are cue points, not hard cuts; if over 2:50, cut the heatmap flash first, then the gap_night_check beat (per LEAD cut order — never the install or compare beats).
6. **Setup:** terminal and Claude font size up (readable at 720p), notifications off, clean browser profile for the heatmap tab, Loom camera bubble bottom-right and small during screen beats.
7. **One number rule:** if a spoken number and the on-screen number ever disagree, the screen wins — re-record the sentence reading it off the screen.

---

## Appendix — FALLBACK ONLY: localhost UI shot list (demo mode)

**Not the primary video.** The localhost UI is a local dev tool — it is not in the npm package, so no user who installs night-margin ever sees it. Lead the video with the MCP tools in Claude (the beats above), which is what people actually get. Keep this only as a backup if the Claude screen recording won't cooperate. Everything below runs in **demo mode with no API key** — instant, no real addresses, and the leak zone still renders (verified). Its one merit: it shows a decision being made and undone live in about 4 seconds, which the MCP transcript can't dramatize as tightly.

Run it as: `NM_STATE_DIR=/tmp/nm-demo npm run ui` → <http://127.0.0.1:8788>

1. **(0:00–0:15)** Open on Targets → a demo property → August → *Nightly prices*: Wheelhouse's blue recommendation line running **under** the black cost-floor line, red fill between them. Read the auto-generated note aloud.
2. **(0:15–0:30)** Hover one red night: the recommendation is €47, the cleaner is €70. That night loses €23 before the guest opens the door.
3. **(0:30–0:45)** Click AGG, then CON on the risk segment. The floor line jumps, the red area and leak-night count redraw instantly — no network call. The floor is a model you tune, not a constant.
4. **(0:45–1:00)** Monthly pace: switch *Fill push* vs *Floor guard*. Month-end gross rises while net estimate falls. Read one assumption bullet aloud — every number names its own source.
5. **(1:00–1:15)** Press the 25% stress button. Floor guard's worst case beats fill push's. Read the verdict line: the decision is made on the downside, not the average.
6. **(1:15–1:35)** Decisions tab: read one row — property, nights, floor vs recommendation, and the euro exposure. Click Preview.
7. **(1:35–1:50)** The modal shows the literal `PUT /listings/{id}/custom_rates` payload and the line "Nothing has been written." That is the real RM API call, previewed.
8. **(1:50–2:05)** Tick the arm checkbox, press Apply: status flips proposed → applied with the write verified back from Wheelhouse.
9. **(2:05–2:15)** Press Revert on the same row: prior rates restored from the pre-write snapshot. This is why it is safe to point at a live portfolio.
10. **(2:15–2:30)** Cut to Claude running the same server over MCP — one `check_alerts` line with the euro exposure — then the install command.

**Do not film the UI against live data.** `/api/analysis` has no server-side cache; cold first paint is ~90 s.
