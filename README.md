# margin-mcp — Katemoottori

MCP-serveri, joka näyttää lyhytvuokrausportfolion hinnoittelupäätökset **nettona vaihtokustannusten jälkeen**. Avainmittari: netto per käytettävissä oleva yö.

> Vaihe 1: `analyze_portfolio` toimii synteettisellä demo-datalla. Wheelhouse- ja CleanHub-adapterit tulevat vaiheessa 2, npx-asennus vaiheessa 3.

## Kokeilu (dev)

```bash
npm install
npm test
npm run build
```

Lisää Claude Codeen:

```bash
claude mcp add margin -- node "<repon polku>/dist/index.js"
```

Kysy sitten Claudelta esim.:

> Analysoi portfolioni kesäkuu 2026 (2026-06-01 → 2026-07-01)

## Konfiguraatio (env)

```
COST_SOURCE=manual         # manual | csv (vaihe 2) | cleanhub (vaihe 2)
AVG_TURNOVER_COST=70       # € per vaihto manual-tilassa
COST_TIERS=1br:55,2br:70,3br:95   # valinnainen, osuma property_id:hen
MIN_MARGIN=25              # aukkoyölattian minimikate €
WHEELHOUSE_API_KEY=        # vaihe 2
```

Kaikki data tässä vaiheessa on synteettistä — repo ei sisällä oikeaa asiakas- tai kohdedataa.
