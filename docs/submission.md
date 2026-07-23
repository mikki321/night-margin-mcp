# Submission draft — Wheelhouse Revenue Hackathon

Draft answers for the submission form. Everything below is copy-paste ready; items marked **TODO** need a value at submit time.

---

## Project name

night-margin-mcp — Margin Engine

## One-liner

The margin guard for Wheelhouse pricing: an MCP server that nets every decision against turnover costs — the metric revenue tools miss, **net per available night**.

## Description (~150 words)

Wheelhouse optimizes what guests pay. night-margin protects what you keep.

Wheelhouse tells you the right price for every night — but no revenue tool knows what a night costs to *produce*. A 2-night and a 7-night booking consume the same cleaning, so gross revenue can climb while margin leaks out through short stays and discounted gap nights.

night-margin-mcp is the margin guard for that gap: an MCP server that shows every pricing decision net of turnover costs. It pulls live listings, reservations and per-night price recommendations from the Wheelhouse RM API, attaches per-booking turnover costs (flat average, CSV, or an ops-platform API), and answers one question: **is Wheelhouse's own recommended price above what that night costs me to produce?**

Eight tools: three read-only analyses (`analyze_portfolio`, `compare_strategies`, `gap_night_check`), a four-step decision loop (`propose_decisions` drafts floor prices → `apply_decision` previews the exact RM API payload, then writes it only with `confirm: true` → `revert_decision` restores the pre-write snapshot), and `check_alerts` for a daily cron.

Live from the Wheelhouse RM API on my own portfolio this week: **206 unsold nights across 9 listings carry a Wheelhouse recommendation below what the night costs me to produce.** On one listing the recommendation is €41–€52 against a €95 floor (€70 turnover + €25 margin). Wheelhouse's own MCP server produces the €41; nothing in it knows the €70.

In the built-in demo portfolio (default window, no API key needed), the same lens on a strategy: filling gap nights at 40% off lifts occupancy from 70.3% to 99.8% and adds €18,009 gross — while net *drops* €1,801.

Install in under a minute: `claude mcp add margin -- npx -y night-margin-mcp`

## Links

- **GitHub:** <https://github.com/mikki321/night-margin-mcp>
- **npm:** <https://www.npmjs.com/package/night-margin-mcp>
- **Live demo (portfolio dashboard + net-per-night heatmap, synthetic data):** <https://mikki321.github.io/night-margin-mcp/>
- **Demo video (Loom):** TODO — add after Thursday recording
- **Install:** `claude mcp add margin -- npx -y night-margin-mcp`

## Category

**Best Build from a Property Manager**

I run Lapland Host, a property management company with 73 short-term rental listings in Rovaniemi, Finnish Lapland — a market with extreme seasonality where gap-night discounting is a weekly temptation. This tool wasn't built *about* property management; it was built *inside* one: the cost model comes from our own turnover operations, and every tool was tested live against our own Wheelhouse portfolio during the hackathon week.

## How it maps to the judging criteria

**Business Value.** It catches decisions that are revenue-positive but profit-negative, before they happen: live this week, 206 unsold nights across 9 of my listings carry a Wheelhouse recommendation below their cost floor, and `propose_decisions` drafted 20 fixes I can apply and undo. On demo data the same lens scores a whole strategy — gap-filling at a 40% discount adds €18,009 gross and loses €1,801 net. Any operator reproduces it with their own Wheelhouse key and one number: what a turnover costs them.

**Completeness.** Not a mockup: published on npm, one-command install, first result in under 60 seconds with zero config (clearly-labeled synthetic data), fully functional with a real Wheelhouse key. Eight working tools, a 329-test suite, actionable error messages, and a public demo page rendered from real server output. On a live 73-listing portfolio the first call takes ~90 seconds — one request per listing, serial, inside Wheelhouse's 60 req/min limit — then results are cached for 10 minutes.

**Technical Execution.** A TypeScript MCP server (official SDK, stdio) integrating the Wheelhouse RM API — listings, per-listing reservations, per-night price recommendations, min-stay calendars, and custom-rate writes — with serial requests and backoff for the 60 req/min limit, live-tested against my own 73-listing portfolio. Turnover costs flow through a pluggable adapter (manual / CSV / HTTP API) with a per-booking attribution cascade reported in every response. The output states its own limits: price recommendations cover a rolling 30-night horizon, so nights beyond it are reported as unchecked rather than silently passed.

**Positioning vs. Wheelhouse's own MCP.** Wheelhouse already ships an MCP server (78 tools — listings, market data, comps). night-margin deliberately does not duplicate it: we add the one layer it cannot have — your turnover costs, net per available night, and a cost-aware decision loop that writes floor prices back with an explicit confirm and an undo. Run both in the same Claude: theirs answers what the market pays, ours answers what you actually keep.

**Creativity.** Revenue management optimizes gross (ADR, RevPAR); this flips the lens with one new metric — net per available night — plus a gap-night floor price (turnover + travel + minimum margin). Shipped in 0.3.0: the decision loop that writes price changes back to Wheelhouse with dry-run, confirm and revert. And because the floor is arithmetic rather than a black box, the tool can offer the other lever: a 15-night gap floored at €95 per night drops to €32 if you set a 3-night minimum stay — the same turnover spread over three nights instead of one.

**Category Fit.** Built by a property manager who runs 73 listings in Lapland — for operators like us. Developed against and live-tested on my own portfolio during the hackathon week, solving a problem my team hits every week.

---

## Submit-time checklist (not part of the form)

Hard sequencing dependency: the npm link above, the "published on npm" claim under Completeness, the README Quick start, and the video's "It's on npm today" close are all true only **after** T8 (npm publish) lands. Verify — don't assume:

- [ ] `npm view night-margin-mcp version` returns 0.3.0 (or later). A 404 means the publish hasn't landed — do **not** record the video's close beat and do **not** send the form yet. Fallback if the registry blocks you: swap every install string to `npx -y github:mikki321/night-margin-mcp` (works today, repo is public), delete the npm link above, and change "published on npm" under Completeness to "one-command install straight from GitHub".
- [ ] Re-run the README Quick start on a clean machine (`claude mcp add margin -- npx -y night-margin-mcp`) and confirm a first tool result.
- [ ] Run both checks twice: once before recording the video, and again immediately before sending the form.
