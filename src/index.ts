#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { runAnalyzePortfolio } from "./tools/analyzePortfolio.js";

const server = new McpServer({ name: "margin-mcp", version: "0.1.0" });

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

await server.connect(new StdioServerTransport());
console.error("margin-mcp käynnissä (stdio)");
