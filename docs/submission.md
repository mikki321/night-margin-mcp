# Submission draft — Wheelhouse Revenue Hackathon

Draft answers for the submission form. Everything below is copy-paste ready; items marked **TODO** need a value at submit time.

---

## Project name

night-margin-mcp — Margin Engine

## One-liner

An MCP server that shows every Wheelhouse pricing decision net of turnover costs — the metric revenue tools miss: **net per available night**.

## Description (~150 words)

Wheelhouse tells you the right price for every night — but no revenue tool knows what a night costs to *produce*. A 2-night and a 7-night booking consume the same cleaning, so gross revenue can climb while margin leaks out through short stays and discounted gap nights.

night-margin-mcp is an MCP server that shows every pricing decision net of turnover costs. It pulls live listings and reservations from the Wheelhouse RM API, attaches per-booking turnover costs (flat average, CSV, or an ops-platform API), and computes one honest metric: net per available night. Three tools: `analyze_portfolio` finds where money leaks, `compare_strategies` puts gross and net in the same picture, `gap_night_check` gives a fill-or-skip verdict with a floor price.

The demo scenario says it all: filling gap nights at 40% off lifts occupancy to 99% and adds €3,977 gross — while net *drops* €433.

Install in under a minute: `claude mcp add margin -- npx -y night-margin-mcp`

## Links

- **GitHub:** <https://github.com/mikki321/night-margin-mcp>
- **npm:** <https://www.npmjs.com/package/night-margin-mcp>
- **Live demo:** <https://mikki321.github.io/night-margin-mcp/>
- **Demo video (Loom):** TODO — add after Thursday recording
- **Install:** `claude mcp add margin -- npx -y night-margin-mcp`

## Category

**Best Build from a Property Manager**

I run Lapland Host, a property management company with 73 short-term rental listings in Rovaniemi, Finnish Lapland — a market with extreme seasonality where gap-night discounting is a weekly temptation. This tool wasn't built *about* property management; it was built *inside* one: the cost model comes from our own turnover operations, and every tool was tested live against our own Wheelhouse portfolio during the hackathon week.

## How it maps to the judging criteria

**Business Value.** It catches decisions that are revenue-positive but profit-negative, today: in the demo scenario, gap-filling at a 40% discount adds €3,977 gross and loses €433 net. This is the analysis my own team runs before touching discounts or min-stay rules — and any operator can reproduce it with their own Wheelhouse key or cost CSV.

**Completeness.** Not a mockup: published on npm, one-command install, first result in under 60 seconds with zero config (clearly-labeled synthetic data), fully functional with a real Wheelhouse key. Three working tools, a 150+ test suite, actionable error messages, and a public demo page rendered from real server output.

**Technical Execution.** A TypeScript MCP server (official SDK, stdio) integrating the Wheelhouse RM API — listings and per-listing reservations (the price-recommendations client is already in place and lands in gap_night_check in 0.2.1), with serial requests and backoff for the 60 req/min limit — live-tested against my own 73-listing portfolio. Turnover costs flow through a pluggable adapter (manual / CSV / HTTP API) with a per-booking attribution cascade reported in every response.

**Creativity.** Revenue management optimizes gross (ADR, RevPAR); this flips the lens with one new metric — net per available night — plus a gap-night floor price (turnover + travel + minimum margin). In progress for 0.3.0: the decision loop (propose → apply → review) that writes price changes back to Wheelhouse, with dry-run, confirm, and revert.

**Category Fit.** Built by a property manager who runs 73 listings in Lapland — for operators like us. Developed against and live-tested on my own portfolio during the hackathon week, solving a problem my team hits every week.

---

## Submit-time checklist (not part of the form)

Hard sequencing dependency: the npm link above, the "published on npm" claim under Completeness, the README Quick start, and the video's "It's on npm today" close are all true only **after** T8 (npm publish) lands. Verify — don't assume:

- [ ] `npm view night-margin-mcp version` returns 0.2.0 (or later). A 404 means T8 hasn't landed — do **not** record the video's close beat and do **not** send the form yet.
- [ ] Re-run the README Quick start on a clean machine (`claude mcp add margin -- npx -y night-margin-mcp`) and confirm a first tool result.
- [ ] Run both checks twice: once before recording the video, and again immediately before sending the form.
