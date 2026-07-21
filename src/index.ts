#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAnalyzePortfolio } from "./tools/analyzePortfolio.js";
import { runCompareStrategies } from "./tools/compareStrategies.js";
import { runGapNightCheck } from "./tools/gapNightCheck.js";

const server = new McpServer({ name: "night-margin-mcp", version: "0.2.0" });

server.registerTool(
  "analyze_portfolio",
  {
    title: "Analysoi portfolion netto per yö",
    description:
      "Laskee lyhytvuokrausportfolion netton vaihtokustannusten (siivous, pyykki, matkat) jälkeen: " +
      "netto per käytettävissä oleva yö, vuoto (nettonegatiiviset varaukset) sekä parhaat ja heikoimmat kohteet.",
    inputSchema: {
      from: z.string().describe("Jakson alku, YYYY-MM-DD"),
      to: z.string().describe("Jakson loppu (eksklusiivinen), YYYY-MM-DD"),
      avg_turnover_cost: z
        .number()
        .positive()
        .optional()
        .describe("Ohita AVG_TURNOVER_COST tälle ajolle: € per vaihto (manual-tila)"),
    },
  },
  async (args) => {
    try {
      const text = await runAnalyzePortfolio(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Virhe: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "compare_strategies",
  {
    title: "Vertaile hinnoittelustrategioita nettona",
    description:
      "Simuloi kaksi hinnoittelustrategiaa ja vertaa niitä baselineen nettona vaihtokustannusten jälkeen: " +
      "A täyttää aukkoyöt alennuksella (oletus 40 % alennus kohteen ADR:stä), B pudottaa alle minimioleskelun " +
      "varaukset ja korottaa loppujen hintoja (oletus min 3 yötä, +10 %). Näyttää per skenaario brutto, netto, " +
      "netto/yö, käyttöaste, vaihdot ja vuoto — paljastaa milloin bruttoa optimoiva täyttö on nettona tappio.",
    inputSchema: {
      from: z.string().describe("Jakson alku, YYYY-MM-DD"),
      to: z.string().describe("Jakson loppu (eksklusiivinen), YYYY-MM-DD"),
      discount_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Strategia A: aukkoyön hinnan alennus prosentteina kohteen ADR:stä (oletus 40)"),
      min_stay: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Strategia B: minimioleskelu öinä — tätä lyhyemmät varaukset pudotetaan (oletus 3)"),
      uplift_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Strategia B: jäljelle jäävien varausten hinnankorotus prosentteina (oletus 10)"),
    },
  },
  async (args) => {
    try {
      const text = await runCompareStrategies(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Virhe: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "gap_night_check",
  {
    title: "Tarkista aukkoyön täyttö (FILL/SKIP)",
    description:
      "Tarkistaa kannattaako yksittäinen aukkoyö täyttää: laskee lattiahinnan (vaihtokustannus + matka + minimikate MIN_MARGIN) " +
      "kohteen toteutuneiden kustannusrivien mediaanista ja vertaa ehdokashintaan → FILL jos hinta ≥ lattia, muuten SKIP. " +
      "Jos päivä on jo varattu, kertoo mikä varaus sen kattaa.",
    inputSchema: {
      property_id: z.string().min(1).describe("Kohteen tunnus varausdatassa (property_id)"),
      date: z.string().describe("Tarkistettava yö, YYYY-MM-DD"),
      candidate_price: z
        .number()
        .positive()
        .optional()
        .describe("Ehdokashinta €/yö — verrataan lattiahintaan; ilman tätä näytetään pelkkä lattia + ohje"),
    },
  },
  async (args) => {
    try {
      const text = await runGapNightCheck(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Virhe: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("night-margin-mcp käynnissä (stdio)");
