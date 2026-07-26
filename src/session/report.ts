/**
 * The `forge --cost` report.
 *
 * Same numbers as the interactive `/cost`, but printable and scriptable — this
 * exists because reading spend previously required either an interactive
 * session or a hand-written SQLite query.
 *
 * Cache hit rate leads, above the dollar figure, for the same reason it does in
 * the TUI: it is the number that says whether the design is working. A dollar
 * total tells you what happened; the hit rate tells you what will keep
 * happening.
 */

import { cacheHitRate, formatCost, formatTokens, type UsageTotals } from './cost.ts';
import type { SessionStore } from './store.ts';

export interface CostReport {
  today: UsageTotals;
  directory: UsageTotals;
  allTime: UsageTotals;
  byModel: Array<{ modelKey: string; totals: UsageTotals }>;
  cwd: string;
}

export function buildCostReport(store: SessionStore, cwd: string): CostReport {
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);

  return {
    today: store.totalsSince(startOfDay.getTime()),
    directory: store.totalsForCwd(cwd),
    allTime: store.totalsAllTime(),
    byModel: store.totalsByModel(),
    cwd,
  };
}

/** Machine-readable form for `--cost --json`. */
export function formatCostJson(report: CostReport): string {
  const shape = (totals: UsageTotals): Record<string, number> => ({
    requests: totals.requests,
    inputTokens: totals.inputTokens,
    cachedInputTokens: totals.cachedInputTokens,
    cacheWriteTokens: totals.cacheWriteTokens,
    outputTokens: totals.outputTokens,
    cost: round(totals.cost),
    uncachedCost: round(totals.uncachedCost),
    saved: round(totals.uncachedCost - totals.cost),
    cacheHitRate: round(cacheHitRate(totals), 4),
  });

  return `${JSON.stringify(
    {
      cwd: report.cwd,
      today: shape(report.today),
      directory: shape(report.directory),
      allTime: shape(report.allTime),
      byModel: report.byModel.map((entry) => ({
        model: entry.modelKey,
        ...shape(entry.totals),
      })),
    },
    null,
    2,
  )}\n`;
}

export function formatCostText(report: CostReport): string {
  const lines: string[] = [];
  const { allTime } = report;

  if (allTime.requests === 0) {
    return 'No usage recorded yet. Run forge on something and check back.\n';
  }

  const hitRate = cacheHitRate(allTime);
  const totalInput =
    allTime.inputTokens + allTime.cachedInputTokens + allTime.cacheWriteTokens;
  const saved = allTime.uncachedCost - allTime.cost;

  lines.push('Usage');
  lines.push('');
  lines.push(
    `  Cache hit rate   ${pct(hitRate)}   ${formatTokens(allTime.cachedInputTokens)} of ${formatTokens(totalInput)} input tokens`,
  );

  if (saved > 0.000005) {
    const percentSaved = allTime.uncachedCost > 0 ? 1 - allTime.cost / allTime.uncachedCost : 0;
    lines.push(
      `  Caching saved    ${formatCost(saved)}  (${formatCost(allTime.uncachedCost)} uncached → ${formatCost(allTime.cost)}, ${pct(percentSaved)} off)`,
    );
  }

  // A low hit rate over a meaningful number of requests is the one failure this
  // whole report exists to surface, so it gets said out loud.
  if (allTime.requests >= 5 && hitRate < 0.15) {
    lines.push('');
    lines.push(
      `  ! Low hit rate over ${allTime.requests} requests. Usually the prompt prefix is changing`,
    );
    lines.push(
      '    between turns — check for model switching mid-session, or something dynamic',
    );
    lines.push('    reaching the system prompt. `forge` then `/context` shows the fingerprint.');
  }

  lines.push('');
  lines.push(row('Today', report.today));
  lines.push(row('This directory', report.directory));
  lines.push(row('All time', report.allTime));

  if (report.byModel.length > 1) {
    lines.push('');
    lines.push('  By model');
    for (const entry of report.byModel) {
      lines.push(
        `    ${entry.modelKey.padEnd(30)} ${formatCost(entry.totals.cost).padStart(10)}  ${String(entry.totals.requests).padStart(4)} req  cache ${pct(cacheHitRate(entry.totals))}`,
      );
    }
  }

  lines.push('');
  lines.push('  Estimated from prices in models.json — providers change rates without notice.');
  lines.push('  Check your provider dashboard for the authoritative figure.');
  lines.push('');

  return lines.join('\n');
}

function row(label: string, totals: UsageTotals): string {
  const input = totals.inputTokens + totals.cachedInputTokens + totals.cacheWriteTokens;
  return `  ${label.padEnd(16)} ${formatCost(totals.cost).padStart(10)}   ${formatTokens(input)} in / ${formatTokens(totals.outputTokens)} out   ${totals.requests} req`;
}

function pct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function round(value: number, places = 6): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
