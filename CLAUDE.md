# CLAUDE.md — Katemoottori (työnimi `margin-mcp`)

## Konteksti

Wheelhouse Revenue Hackathon 21.–24.7.2026. Submission **torstaina 23.7. keskiyöllä PST**, demo perjantaina. Rakentaja: Miki, solo. Sinä (Claude Code) teet toteutuksen; Miki ajaa curlit, testaa ja päättää.

## Mitä rakennetaan ja miksi

Wheelhouse on lyhytvuokrauksen revenue management -alusta, joka optimoi bruttotuottoa (ADR, RevPAR). Yksikään RM-työkalu ei tiedä, mitä yön **tuottaminen** maksaa: kahden yön ja seitsemän yön varaus kuluttavat saman siivouksen, ja aukkoyön täyttö halvalla voi olla nettona negatiivinen.

Rakennamme **MCP-serverin, joka näyttää jokaisen hinnoittelupäätöksen myös nettona vaihtokustannusten jälkeen**. Avainmittari: **netto per käytettävissä oleva yö**.

Erottautuminen: meillä on CleanHub (oma kenttäoperaatioalusta) → todelliset vaihtokustannukset per varaus. Muut käyttäjät ajavat työkalua yhdellä keskiarvoluvulla tai CSV:llä.

Käyttäjät: hackathonin osallistujat asentavat tämän omaan Claudeensa ja ajavat omaa portfoliotaan vasten. Voitto ratkeaa avoimella äänestyksellä → **asennuksen ja ensimmäisen tuloksen pitää onnistua alle minuutissa**.

## Arkkitehtuuri

- Standalone TypeScript MCP-serveri: `@modelcontextprotocol/sdk`, stdio-transport
- **Ei mitään riippuvuutta CleanHubin koodiin** — CleanHub on vain yksi datalähde HTTP:n yli
- Kustannuslähteet adapterimallilla: `manual | csv | cleanhub` (env `COST_SOURCE`)
- `/web`: kevyt demo-UI (vaihe 4, matalin prioriteetti)

```
src/core/        puhdas laskenta, ei I/O:ta
src/sources/     cost-adapterit: manual.ts, csv.ts, cleanhub.ts
src/wheelhouse/  WH RM API -client
src/tools/       MCP-toolit
src/index.ts     serverin käynnistys
test/            vitest, synteettinen data
examples/        sample-costs.csv (synteettinen)
web/             vaihe 4
```

## Ydinlaskenta (`src/core`)

```
netto_per_yo   = (gross_revenue − cleaning − laundry − travel) / kaytettavissa_olevat_yot
kaytettavissa  = varatut yöt + aukkoyöt tarkastelujaksolla   # määritelmä yhdessä paikassa
aukkoyolattia  = turnover_cost + travel + MIN_MARGIN
vuoto          = Σ(negatiivisten netto-öiden €)  ja  % kaikista varatuista öistä
```

Kirjoita ensin puhtaat funktiot ja testit synteettisellä datalla. Vasta sitten adapterit.

## MCP-toolit

### P0 — `analyze_portfolio`
- in: `from`, `to` (ISO-päivät); valinnainen kustannusohitus parametrina
- out: `leak_pct`, `leak_eur`, bottom-10 ja top-5 kohteet netto/yö-järjestyksessä, yhden lauseen yhteenveto

### P1 — `compare_strategies`
- in: jakso + kaksi strategiaa `{min_stay, price_delta_pct, fill_gaps}`
- out: per strategia brutto €, netto €, käyttöaste, vaihtomäärä + delta-lause
- Kaksi kovakoodattua esimerkkistrategiaa riittää. **Ei yleistä sääntökonetta.**

### P1 — `gap_night_check`
- in: `property_id`, `date`
- out: WH-suositushinta (jos avain), lattiahinta, verdikti fill/skip

Tool-vastaukset: selkeää tekstiä + pienet taulukot. Virhetilanteissa toimintaohje käyttäjälle (esim. "aseta WHEELHOUSE_API_KEY ympäristömuuttujaan — ohje READMEssä").

## Konfiguraatio (env)

```
WHEELHOUSE_API_KEY=        # käyttäjän oma avain
COST_SOURCE=manual         # manual | csv | cleanhub
AVG_TURNOVER_COST=70       # manual-tila: € per vaihto
COST_TIERS=                # valinnainen: "1br:55,2br:70,3br:95"
CLEANHUB_API_URL=          # vain Mikin instanssissa
CLEANHUB_TOKEN=
CSV_PATH=                  # csv-tila
MIN_MARGIN=25              # aukkoyölattian minimikate €
```

## Data contractit

**CleanHub** (rakennetaan CleanHubin päähän erikseen — tämä repo vain kuluttaa):
```
GET {CLEANHUB_API_URL}/api/exports/turnover-costs?from=YYYY-MM-DD&to=YYYY-MM-DD
Authorization: Bearer <CLEANHUB_TOKEN>
```
Rivit: `reservation_id, property_id, checkin, checkout, nights, gross_revenue, cleaning_cost, travel_cost, laundry_cost, turnover_date, is_sunday_or_holiday`

**CSV**: sama skeema otsikkoriveinä. Generoi synteettinen `examples/sample-costs.csv`.

**Wheelhouse RM API**: dokumentaatio https://api.usewheelhouse.com/wheelhouse_rm_api

## Työskentelysäännöt

0. **KIELISÄÄNTÖ (Miki 21.7.): kaikki käyttäjälle näkyvä ENGLANNIKSI** — tool-tulosteet, virheviestit, toolien descriptionit, zod-describet, README, package.json-description. Sisäiset työdokut (tämä tiedosto, TEAM.md, plan, commitit) saavat olla suomeksi. Tiimin roolit ja valtuudet: ks. TEAM.md.
1. **Älä arvaa Wheelhouse-API:n kenttiä tai vastausmuotoja.** Pyydä Mikiä ajamaan curl ja liittämään vastaus; rakenna parseri todellisen vastauksen mukaan.
2. Core pysyy puhtaana ja testattuna; adapterit ohuina.
3. **Ei oikeaa asiakas- tai kohdedataa** repoon, testeihin tai READMEen — vain synteettistä tai Wheelhousen sample-dataa. Repo voi päätyä julkiseksi.
4. Riippuvuudet minimissä: sdk, zod, vitest, csv-parse. Ei muuta ilman syytä.
5. Pienet commitit toimivina kokonaisuuksina.
6. Jokainen vaihe päättyy: testit vihreinä + lyhyt "näin kokeilet" -ohje Mikille.

## Vaiheet ja valmiin määritelmä

**Vaihe 1 (ti):** skeleton, core + testit, manual-source, `analyze_portfolio` päästä päähän mock-varauksilla. Valmis kun: tool palauttaa vuotoluvun synteettisellä datalla Mikin Claudessa.

**Vaihe 2 (ti-ilta/ke):** WH-API-adapteri oikealla datalla + cleanhub-source. Valmis kun: Mikin oma portfolio analysoituu actualeilla.

**Vaihe 3 (KE — kova deadline):** npx-paketointi + README (asennus yhdellä komennolla, sample-CSV, 3 esimerkkipromptia). Valmis kun: puhdas kone → toimiva tulos alle minuutissa. **Julkaisu keskiviikkona.**

**Vaihe 4 (to):** `compare_strategies`, `gap_night_check`, `/web` (lämpökartta + triage, timebox 3 h).

**Cut line:** jos keskiviikon julkaisu uhkaa, ulos menee pelkkä `analyze_portfolio`. `/web` leikataan ensimmäisenä.

## Ei-skooppia

Yleinen strategiasääntökone · auth/multi-user/hosting · kirjoitusoperaatiot Wheelhouseen · per-kohde manuaalisyötöt · kapasiteettihinnoittelu ja kannibalisointi (vain slideihin)
