#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { analyzePortfolioInputSchema, runAnalyzePortfolio } from "./tools/analyzePortfolio.js";
import { applyDecisionInputSchema, runApplyDecision } from "./tools/applyDecision.js";
import { compareStrategiesInputSchema, runCompareStrategies } from "./tools/compareStrategies.js";
import { runGapNightCheck } from "./tools/gapNightCheck.js";
import { proposeDecisionsInputSchema, runProposeDecisions } from "./tools/proposeDecisions.js";
import { revertDecisionInputSchema, runRevertDecision } from "./tools/revertDecision.js";
import { runSetTarget, setTargetInputSchema } from "./tools/setTarget.js";

const server = new McpServer({ name: "night-margin-mcp", version: "0.3.0-dev" });

server.registerTool(
  "analyze_portfolio",
  {
    title: "Analyze portfolio net per available night",
    description:
      "Computes a short-term rental portfolio's net after turnover costs (cleaning, laundry, travel): " +
      "net per available night, leak (net-negative bookings), and the best and worst properties. " +
      "Read-only — never changes any prices. " +
      "from/to are optional — without them the window defaults to the last 30 + next 90 days.",
    inputSchema: analyzePortfolioInputSchema,
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
      "occupancy, turnovers, and leak per scenario — revealing when gross-optimizing fill is a net loss. " +
      "Strategy A assumes every gap night sells at the discounted price — an upper bound, not a forecast. " +
      "Read-only simulation — never changes any prices. " +
      "from/to are optional — without them the window defaults to the last 30 + next 90 days.",
    inputSchema: compareStrategiesInputSchema,
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
      "The verdict reports both the floor clearance and the actual net after turnover costs. " +
      "If the date is already booked, reports which booking covers it. Read-only — never changes any prices.",
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

server.registerTool(
  "propose_decisions",
  {
    title: "Propose pricing decisions (gap night floors)",
    description:
      "Proposes concrete pricing decisions in euros: finds upcoming gap nights where the current price " +
      "recommendation is below your cost floor (turnover + travel + MIN_MARGIN) and proposes fixing those " +
      "nights at the floor so they can't sell below cost. Proposals are saved to the local decision log " +
      "(NM_STATE_DIR, default ~/.night-margin). Window defaults to the next 30 days. " +
      "Proposing never changes prices — prices change only when a decision is applied with apply_decision and explicit confirmation.",
    inputSchema: proposeDecisionsInputSchema,
  },
  async (args) => {
    try {
      const text = await runProposeDecisions(args);
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
  "apply_decision",
  {
    title: "Apply a pricing decision to Wheelhouse",
    description:
      "Applies a proposed pricing decision to Wheelhouse for real (writes fixed custom rates for the decision's " +
      "gap nights). This tool DOES change prices — but only with explicit confirm=true; it defaults to a dry run " +
      "that shows the exact payload without writing anything. " +
      "The prior custom rates are snapshotted to the decision log before writing, so every applied decision " +
      "can be undone with revert_decision. Requires WHEELHOUSE_API_KEY.",
    inputSchema: applyDecisionInputSchema,
  },
  async (args) => {
    try {
      const text = await runApplyDecision(args);
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
  "revert_decision",
  {
    title: "Revert an applied pricing decision",
    description:
      "Reverts an applied pricing decision: deletes the custom rates it wrote in Wheelhouse and restores any " +
      "prior custom rates from the snapshot taken before the write. This tool DOES change prices — but only " +
      "with explicit confirm=true; without it you get a preview. Requires WHEELHOUSE_API_KEY.",
    inputSchema: revertDecisionInputSchema,
  },
  async (args) => {
    try {
      const text = await runRevertDecision(args);
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
  "set_target",
  {
    title: "Set a monthly gross revenue target",
    description:
      "Sets a monthly gross revenue target for a property (saved locally to NM_STATE_DIR, default " +
      "~/.night-margin). Shows the month's booked gross so far when it can be computed. analyze_portfolio " +
      "then reports progress toward any targets whose month overlaps the analysis window.",
    inputSchema: setTargetInputSchema,
  },
  async (args) => {
    try {
      const text = await runSetTarget(args);
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
