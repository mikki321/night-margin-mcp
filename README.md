# night-margin-mcp — Katemoottori

MCP-serveri, joka näyttää lyhytvuokrausportfolion hinnoittelupäätökset **nettona vaihtokustannusten jälkeen**. Wheelhouse optimoi bruttoa (ADR, RevPAR) — tämä työkalu kertoo, mitä yön *tuottaminen* maksaa. Avainmittari: **netto per käytettävissä oleva yö**.

## Quick start

```bash
claude mcp add margin -- npx -y night-margin-mcp
```

Siinä kaikki — **toimii nollakonfigilla synteettisellä demo-datalla**. Avaa Claude ja kysy:

> Analysoi portfolioni kesäkuu 2026 (2026-06-01 → 2026-07-01)

Saat vuotoluvun, netto/yö-mittarin sekä parhaat ja heikoimmat kohteet alle minuutissa. Kun haluat ajaa analyysin *omaa* Wheelhouse-portfoliotasi vasten, katso [Wheelhouse-API-avain](#wheelhouse-api-avain) alta.

## Esimerkkipromptit

Serveri tarjoaa kolme toolia. Kokeile näitä suoraan Claudessa:

1. **`analyze_portfolio`** — missä raha vuotaa?
   > Analysoi portfolioni 2026-06-01 → 2026-07-01. Missä kohteissa netto/yö on heikoin ja paljonko vuotoa nettonegatiivisista varauksista syntyy?

2. **`compare_strategies`** — brutto vs. netto samassa kuvassa:
   > Vertaa kesäkuulle 2026 kahta strategiaa: (A) täytä aukkoyöt 40 % alennuksella ja (B) nosta minimiyöpyminen kolmeen yöhön 10 % hinnankorotuksella. Kumpi tuottaa paremman netto/yön?

3. **`gap_night_check`** — kannattaako yksittäinen aukkoyö täyttää?
   > Kohteella demo-1br-01 on aukkoyö 2026-06-23. Mikä on lattiahinta, ja kannattaako yö täyttää?

Demon ydinviesti: **bruttoa optimoiva täyttö voi olla nettona tappio** — kahden yön ja seitsemän yön varaus kuluttavat saman siivouksen.

## Konfiguraatio (env)

Kaikki asetukset ovat valinnaisia — ilman niitä serveri ajaa manual-kustannusmallia synteettisellä demo-datalla. Env-muuttujat annetaan `claude mcp add`in `-e`-lipuilla:

```bash
claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -e COST_SOURCE=csv -e CSV_PATH=/polku/costs.csv -- npx -y night-margin-mcp
```

| Muuttuja | Oletus | Selitys |
|---|---|---|
| `WHEELHOUSE_API_KEY` | – | Oma Wheelhouse-integraatioavain. Asetettuna varaukset haetaan Wheelhouse RM API:sta; ilman avainta käytetään synteettistä demo-dataa. |
| `COST_SOURCE` | `manual` | Vaihtokustannusten lähde: `manual` \| `csv` \| `cleanhub`. |
| `AVG_TURNOVER_COST` | `70` | Manual-tila: € per vaihto (siivous). Toimii myös csv-tilan fallbackina, jos varaukselta puuttuu kustannusrivi. |
| `COST_TIERS` | – | Valinnainen porrastus, esim. `1br:55,2br:70,3br:95` — osuma kohteen `property_id`:hen substring-vertailulla, muut saavat `AVG_TURNOVER_COST`in. |
| `CSV_PATH` | – | Csv-tila: polku kustannus-CSV:hen (pakollinen kun `COST_SOURCE=csv`). Katso [CSV-tila](#csv-tila). |
| `CLEANHUB_API_URL` / `CLEANHUB_TOKEN` | – | Cleanhub-tila: toteutuneet vaihtokustannukset CleanHub-kenttäoperaatioalustasta HTTP:n yli (molemmat pakollisia kun `COST_SOURCE=cleanhub`). |
| `MIN_MARGIN` | `25` | Aukkoyölattian minimikate €: lattia = vaihto + matka + `MIN_MARGIN`. Käytetään `gap_night_check`in fill/skip-verdiktissä. |

## CSV-tila

Jos tiedät todelliset vaihtokustannuksesi per varaus, saat tarkimman analyysin CSV:llä. Skeema (otsikkorivi pakollinen):

```
reservation_id,property_id,checkin,checkout,nights,gross_revenue,cleaning_cost,travel_cost,laundry_cost,turnover_date,is_sunday_or_holiday
demo-1br-01-r1,demo-1br-01,2026-06-03,2026-06-10,7,571,56,16,9,2026-06-10,false
```

Synteettinen esimerkkitiedosto (887 riviä, kattaa demo-datan koko kalenterivuoden 2026) tulee paketin mukana hakemistossa `examples/sample-costs.csv`, ja se on ladattavissa suoraan:

```
https://raw.githubusercontent.com/<GITHUB_USER>/night-margin-mcp/main/examples/sample-costs.csv
```

> Huom: linkki päivitetään lopulliseen osoitteeseen, kun repo julkaistaan GitHubiin.

Käyttö:

```bash
curl -o costs.csv "https://raw.githubusercontent.com/<GITHUB_USER>/night-margin-mcp/main/examples/sample-costs.csv"
claude mcp add margin -e COST_SOURCE=csv -e CSV_PATH="$PWD/costs.csv" -- npx -y night-margin-mcp
```

Kustannusrivit kohdistetaan varauksiin ensisijaisesti `reservation_id`:llä, toissijaisesti komposiittiavaimella `property_id|checkin|checkout`. Tool-vastaus kertoo kohdistuksen laadun (esim. "Kustannuskohdistus: 41 id, 6 komposiitti, 3 keskiarvo"). Jos rivi puuttuu eikä `AVG_TURNOVER_COST`-fallbackia ole asetettu, saat selkeän virheen puuttuvien varausten listalla.

## Wheelhouse-API-avain

Ilman avainta serveri ajaa synteettistä demo-dataa (ja sanoo sen joka vastauksessa). Avaimella saat **oikeat varauksesi** Wheelhouse RM API:sta: serveri hakee listaukset ja varaukset, ja kaikki mittarit lasketaan omasta portfoliostasi.

- Avain on oma Wheelhouse-integraatioavaimesi (API:n `X-Integration-Api-Key`-header). Saat sen Wheelhouse-tilisi integraatioasetuksista tai Wheelhousen tuelta — API-dokumentaatio: <https://api.usewheelhouse.com/wheelhouse_rm_api>.
- Aseta se env-muuttujaan: `claude mcp add margin -e WHEELHOUSE_API_KEY=xxx -- npx -y night-margin-mcp`.
- **Älä koskaan laita avainta gitiin** — ei `.env`-tiedostoon repossa, ei README-esimerkkeihin, ei committeihin. Avain kulkee vain ympäristömuuttujana.

Jos avain on virheellinen tai verkko pätkii, serveri antaa selkeän virheen toimintaohjeineen — se **ei** pudota sinua hiljaa demo-dataan, jotta et koskaan luule mock-lukuja omiksesi.

## Kehittäjälle

Paikallinen kehitys:

```bash
npm install
npm test
npm run build
claude mcp add margin -- node "<repon polku>/dist/index.js"
```

Jos npm-paketti ei jostain syystä toimi, sama serveri asentuu suoraan GitHubista:

```bash
claude mcp add margin -- npx -y github:<GITHUB_USER>/night-margin-mcp
```

### Wheelhouse-API:n tutkiminen curlilla

Näillä komennoilla varmistat authin ja näet vastausmuodot (redaktoi vieraiden nimet/sähköpostit ennen jakamista; kenttänimet ja muodot säilytetään):

```bash
# 1) Listings — vahvistaa authin + antaa listing_id:n ja channelin
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings?per_page=5&page=1" | head -c 4000

# 2) Varaukset — SE blokkaava (2–3 varauksen täysi JSON)
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/reservations?channel=<CHANNEL>" | head -c 6000

# 3) Hintasuositukset — gap_night_checkiä varten, matalampi prioriteetti
curl -s -H "X-Integration-Api-Key: $WHEELHOUSE_API_KEY" \
  "https://api.usewheelhouse.com/ss_api/v1/listings/<LISTING_ID>/price_recommendations?channel=<CHANNEL>" | head -c 4000
```

Rate limit on 60 pyyntöä/min — serveri ajaa pyynnöt sarjassa ja tekee 429-vastauksiin backoffin (2 s / 4 s / 8 s).

## Laskennan ydin

```
netto_per_yö   = (brutto − siivous − pyykki − matkat) / käytettävissä olevat yöt
käytettävissä  = varatut yöt + aukkoyöt tarkastelujaksolla
aukkoyölattia  = vaihtokustannus + matka + MIN_MARGIN
vuoto          = Σ(nettonegatiivisten varausten €) ja % varatuista öistä
```

Kaikki repon ja paketin mukana tuleva data on synteettistä — mukana ei ole oikeaa asiakas- tai kohdedataa.
