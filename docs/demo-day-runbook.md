# Demo Day runbook — night-margin-mcp

Perjantai 24.7.2026. **3 min live demo + 2 min tuomarien kysymykset.**
Kaikki alla olevat tulosteet on ajettu ja verifioitu 24.7. klo 20 — luvut ovat sitä mitä ruudulla oikeasti lukee.

Ajotila: **demodata, ei API-avainta** (`WHEELHOUSE_API_KEY` pois). Syyt: vastaus tulee sekunnissa (oikea 73 kohteen portfolio on ~90 s kylmänä, sarjassa, 60 req/min), ruudulla ei ole oikeita osoitteita eikä vieraiden tietoja, ja demodata on selkeästi merkitty jokaisessa tulosteessa.

---

## Pre-flight (10 min ennen)

1. **Tuore Claude-sessio**, fonttikoko ylös (luettava 720p-striimissä), ilmoitukset pois, muut välilehdet kiinni.
2. Varmista serveri: `claude mcp list` → `margin` vastaa. Jos ei: `claude mcp add margin -- npx -y night-margin-mcp`.
3. **Aja kaikki 5 promptia kertaalleen läpi ennen lähetystä** ja jätä sessio auki — jos jokin jumittaa livenä, skrollaat vain ylös. Tämä on tärkein yksittäinen turvatoimi.
4. Avaa toiselle välilehdelle <https://mikki321.github.io/night-margin-mcp/> (vastaa 200, tarkistettu).
5. Sekuntikello näkyviin. Jos olet 2:30 kohdalla vielä beatissä 3, hyppää suoraan closeen.

---

## 3:00 — beat by beat

### 0:00–0:20 · Koukku (puhut, ruudulla tyhjä Claude)

> I run seventy-three short-term rentals in Lapland. My revenue tool optimizes gross, and it's good at it. But nobody knows what a night costs to *produce* — cleaning, laundry, travel. When that cost is a quarter of a cheap night's revenue, filling the calendar can lose you money. So I built night-margin: the margin guard that nets every pricing decision against turnover cost, inside Claude.

### 0:20–0:35 · Asennus (näytä komento, älä odota latausta)

> One command, no config: `claude mcp add margin -- npx -y night-margin-mcp`. It ships with a synthetic demo portfolio, so you get a first answer in under a minute. Add your Wheelhouse key and the same tools run on your real bookings.

### 0:35–1:15 · `analyze_portfolio` — vuoto ensin

**Prompti:** `Where is my portfolio leaking money in June 2026?`
*(Päivämäärä on pakko sanoa — ilman sitä ikkuna on oletusarvoinen ja luvut ovat eri.)*

Ruudulla (verifioitu):
```
Portfolio 2026-06-01 → 2026-07-01
€132 is leaking from 8 bookings that don't cover their own turnover cost. (4.0% of booked nights are net-negative)
Net per available night: €74.7
Occupancy 72.9% (175 booked, 65 gap nights)
```

> First question: where am I leaking? It pulls the bookings, attaches turnover costs, and leads with the leak — a hundred and thirty-two euros from eight bookings that don't cover their own cleaning. Revenue on paper, a loss in practice. Then the metric revenue tools don't have: **net per available night, seventy-four seventy**. And the worst properties ranked — that's tomorrow morning's to-do list.

Näytä alin rivi taulukosta: `demo-1br-03 · €21.4/night`.

### 1:15–1:50 · `compare_strategies` — brutto ylös, netto alas

**Prompti:** `Compare two strategies for June 2026: (A) fill gap nights at a 40% discount and (B) raise the minimum stay to three nights with a 10% price increase.`

Ruudulla (verifioitu — **HUOM: nämä ovat eri luvut kuin vanhassa videokäsikirjoituksessa**):
```
Baseline  €22,821 gross  €17,921 net  €74.7/night  72.9%
A: fill   €26,797 gross  €17,487 net  €72.9/night  99.2%   leak €807
A brings €3,977 more gross but €433 less net — gross-optimizing fill is a net loss.
```

> Now the trap every gross-optimizer walks into. Strategy A fills every gap night at forty percent off. Occupancy jumps from seventy-three to ninety-nine percent, gross up nearly four thousand euros — and net goes *down* four hundred and thirty-three. The leak grows from €132 to €807. Because a two-night and a seven-night booking consume exactly the same cleaning.

### 1:50–2:10 · `gap_night_check` — yksi yö

**Prompti:** `Property demo-1br-03 has a gap night on 2026-08-26. Is it worth filling at €79?`
*(Käytä tätä päivää. Vanhan käsikirjoituksen 2026-06-23 on nyt menneisyydessä ja tuloste lisää "this night is in the past" -huomautuksen.)*

Ruudulla (verifioitu):
```
Floor €95 (turnover 70 + travel 0 + margin 25) · candidate price €79 → SKIP
— €16 below floor; filling would net +€9 after costs.
```

> For a single night: it computes a floor — turnover plus travel plus your minimum margin — and gives a verdict. Seventy-nine euros is sixteen below the floor. Note what it does *not* do: it doesn't tell you that night loses money, because after costs it still nets nine euros. It tells you it's below the margin you said you wanted. That threshold is a dial, not a black box.

### 2:10–2:45 · Päätöskierto — `margin_copilot` → `apply_decision`

**Prompti 1:** `What are my biggest money moves right now?`

Ruudulla (verifioitu):
```
2 money-moves · €630 total below-floor exposure across 35 nights, ranked by exposure.
1. demo-1br-03 — 19 upcoming nights priced below cost (€342)
   Hold / Guard the floor (recommended) / Raise the minimum stay
```

**Prompti 2:** `Preview applying the first one.`

Ruudulla (verifioitu):
```
PUT /listings/mock/custom_rates?channel=mock
{ "start_date": "2026-08-19", "end_date": "2026-08-24", "rate_type": "fixed", ... 95 ... }
Nothing has been written. To execute: apply_decision {"decision_id": "d127", "confirm": true}
```

> It doesn't stop at analysis. Copilot ranks where the money actually moves and weighs the options — hold, guard the floor, or raise the minimum stay — and marks one recommended. Then this: the literal Wheelhouse RM API payload, previewed. **Nothing has been written.** It writes only with an explicit confirm, snapshots the prior rates first, and `revert_decision` puts them back. That's why it's safe to point at a live portfolio.

### 2:45–3:00 · Close

> Wheelhouse tells you what the market pays. night-margin tells you what you keep. Ten tools, three hundred and seventy-two tests, live-tested on my own seventy-three listings this week. Built by a property manager, for operators like us.

---

## Jos jokin pettää livenä

| Ongelma | Tee tämä |
|---|---|
| MCP ei vastaa / verkko pätkii | Skrollaa ylös esiajettuihin vastauksiin ja jatka puhetta normaalisti. |
| Claude-sessio kaatuu | Vaihda selainvälilehteen <https://mikki321.github.io/night-margin-mcp/> ja kerro sama tarina heatmapin päältä. |
| Ruudunjako ei toimi | Soita `Night Margin Pitch.mp4` (73 s, **mykkä** — sinun täytyy puhua päälle) ja täytä loput puheella. |

**Sääntö:** jos puhuttu luku ja ruudun luku eroavat, ruutu voittaa — sano ruudun luku ääneen ja jatka.

---

## Q&A — 2 min, todennäköisimmät kysymykset

**"Eikö tyhjä yö tuota nollan? Miksi €79 ei ole parempi kuin ei mitään?"**
Tämä on terävin kysymys — vastaa täsmällisesti, älä liioittele.
> Below the turnover cost itself it's a real cash loss — in June, eight bookings netted between minus two and minus thirty-nine euros. Above it, like the seventy-nine euro night, you do make nine euros — it's just below the twenty-five euro margin you told the tool you want. So it's a policy floor, and it's a dial: conservative doubles the margin, aggressive cuts it to forty percent. The tool is explicit that below-floor exposure is *not* forecast lost revenue, because an unsold night earns nothing either way. It refuses to claim a gain it can't prove.

**"Mitä eroa tällä on Wheelhousen omaan MCP-serveriin (78 toolia)?"**
> Theirs answers what the market pays; it has listings, comps, market data. Ours adds the one layer it structurally cannot have: your turnover costs. Their MCP produces the forty-one euro recommendation on one of my listings; nothing in it knows about the seventy euro cleaning. Run both in the same Claude — they compose, they don't compete.

**"Mistä kustannusdata tulee? Toimiiko tämä muille kuin sinulle?"**
> Three adapters: one flat number, a CSV, or an HTTP API. The flat number is the whole onboarding — what does a turnover cost you. I happen to have per-booking actuals from our own ops platform, which is where the CSV schema comes from, but nobody needs that to use this. Zero config runs on synthetic demo data.

**"Kirjoittaako se oikeasti Wheelhouseen?"**
> Yes — `PUT custom_rates`. Dry run by default, writes only with `confirm: true`, snapshots the prior rates before writing, and `revert_decision` restores them. You saw the preview say "nothing has been written."

**"Milloin tämä EI kannata?"** *(Vastaa tähän rehellisesti — se on vahvin kohtasi.)*
> My own winter. High ADR — bookings average four hundred and eighty-one euros a night, turnover is under four percent of gross. The tool runs November to March and says: no leak, leave your prices alone. `review_history` on my own nine months shows it — turnover ate five percent of gross in December and thirty-four percent in the shoulder season. The operator this really serves is low ADR, short stays, high occupancy, where a seventy euro turnover is a quarter of a two-night booking.

**"Onko tämä testattu oikealla datalla vai vain demolla?"**
> Live against my own seventy-three listings all week — listings, reservations, per-night price recommendations, min-stay calendars, monthly KPIs, custom-rate writes. This week it found two hundred and six unsold nights across nine listings where the Wheelhouse recommendation sits below what the night costs me to produce. What you saw on screen is the synthetic demo portfolio, clearly labeled in every response, so no guest data goes on a webinar stream.

**"Miten se skaalaa? Rate limitit?"**
> Serial requests inside Wheelhouse's sixty per minute limit, with backoff, and a ten-minute cache. A cold seventy-three listing scan is about ninety seconds; after that it's instant. The tool tells you when it's still scanning instead of looking frozen.

**"Mikä on keskeneräistä?"**
> Price recommendations cover a rolling thirty-night horizon, so anything beyond that is reported as *unchecked* rather than silently passed — that's stated in the output, not hidden. Costs are attributed per booking through a cascade that names which match it used. And there's no multi-user hosting: it's your machine, your key, your data.

---

## Kaksi asiaa jotka on korjattava ennen lavaa

1. **npm-julkaisu.** `npm view night-margin-mcp` → 404. Asennuskomento, README ja submissio lupaavat npm:ää. Julkaise (`npm login` → publish) tai älä sano "on npm" lavalla — GitHub-polku `npx -y github:mikki321/night-margin-mcp` on testattu ja toimii puhtaalta koneelta.
2. **Vanha `docs/video-script.md`** sisältää eri luvut (portfoliodatasta) kuin mitä demodata näyttää. Käytä tätä runbookia, älä sitä.
