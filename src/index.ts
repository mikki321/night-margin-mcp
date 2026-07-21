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
    title: "Analyze portfolio net per available night",
    description:
      "Computes a short-term rental portfolio's net after turnover costs (cleaning, laundry, travel): " +
      "net per available night, leak (net-negative bookings), and the best and worst properties.",
    inputSchema: {
      from: z.string().describe("Period start, YYYY-MM-DD"),
      to: z.string().describe("Period end (exclusive), YYYY-MM-DD"),
      avg_turnover_cost: z
        .number()
        .positive()
        .optional()
        .describe("Override AVG_TURNOVER_COST for this run: € per turnover (manual mode)"),
    },
  },
  async (args) => {
    try {
      const text = await runAnalyzePortfolio(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "compare_strategies",
  {
    title: "Compare pricing strategies on net",
    description:
      "Simulates two pricing strategies and compares them to the baseline on net after turnover costs: " +
      "A fills gap nights at a discount (default 40% off the property's ADR), B drops bookings below a minimum " +
      "stay and raises the remaining prices (default min 3 nights, +10%). Shows gross, net, net/night, " +
      "occupancy, turnovers, and leak per scenario — revealing when gross-optimizing fill is a net loss.",
    inputSchema: {
      from: z.string().describe("Period start, YYYY-MM-DD"),
      to: z.string().describe("Period end (exclusive), YYYY-MM-DD"),
      discount_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Strategy A: gap night price discount as a percentage of the property's ADR (default 40)"),
      min_stay: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Strategy B: minimum stay in nights — bookings shorter than this are dropped (default 3)"),
      uplift_pct: z
        .number()
        .min(0)
        .max(100)
        .optional()
        .describe("Strategy B: price uplift percentage for the remaining bookings (default 10)"),
    },
  },
  async (args) => {
    try {
      const text = await runCompareStrategies(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

server.registerTool(
  "gap_night_check",
  {
    title: "Check gap night fill (FILL/SKIP)",
    description:
      "Checks whether filling a single gap night is worth it: computes the floor price (turnover cost + travel + minimum margin MIN_MARGIN) " +
      "from the median of the property's actual cost rows and compares the candidate price against it → FILL if price ≥ floor, otherwise SKIP. " +
      "If the date is already booked, reports which booking covers it.",
    inputSchema: {
      property_id: z.string().min(1).describe("Property identifier in the reservation data (property_id)"),
      date: z.string().describe("Night to check, YYYY-MM-DD"),
      candidate_price: z
        .number()
        .positive()
        .optional()
        .describe("Candidate price €/night — compared against the floor price; without it only the floor + guidance is shown"),
    },
  },
  async (args) => {
    try {
      const text = await runGapNightCheck(args);
      return { content: [{ type: "text" as const, text }] };
    } catch (e) {
      return {
        content: [{ type: "text" as const, text: `Error: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

await server.connect(new StdioServerTransport());
console.error("night-margin-mcp running (stdio)");
