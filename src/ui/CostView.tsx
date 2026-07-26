/**
 * The /cost report.
 *
 * Cache hit rate is the first thing on screen, above the dollar figure, because
 * it is the number that tells you whether forge is working as designed. A
 * session sitting near 0% after several turns means something is invalidating
 * the prompt prefix, and on DeepSeek that is a ~50x cost difference — so it
 * gets an explicit diagnostic line rather than leaving the user to notice.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.ts';
import { cacheHitRate, formatCost, formatTokens, type UsageTotals } from '../session/cost.ts';

interface CostViewProps {
  session: UsageTotals;
  today: UsageTotals;
  allTime: UsageTotals;
  byModel: Array<{ modelKey: string; totals: UsageTotals }>;
  /** True when a subscription-priced model was used and $0 is expected. */
  hasSubscriptionModel: boolean;
}

export function CostView({
  session,
  today,
  allTime,
  byModel,
  hasSubscriptionModel,
}: CostViewProps): React.ReactElement {
  const hitRate = cacheHitRate(session);
  const saved = session.uncachedCost - session.cost;

  return (
    <Box flexDirection="column" marginY={1} paddingX={1} borderStyle="round" borderColor="gray">
      <Text bold color={theme.accent}>
        Usage
      </Text>

      {/* --- The headline number ------------------------------------------ */}
      <Box marginTop={1}>
        <Text>Cache hit rate: </Text>
        <Text bold color={hitRateColor(hitRate, session.requests)}>
          {(hitRate * 100).toFixed(1)}%
        </Text>
        <Text color={theme.dim}>
          {'  '}
          {formatTokens(session.cachedInputTokens)} of{' '}
          {formatTokens(
            session.inputTokens + session.cachedInputTokens + session.cacheWriteTokens,
          )}{' '}
          input tokens
        </Text>
      </Box>

      {session.requests >= 3 && hitRate < 0.1 ? (
        <Box paddingLeft={2}>
          <Text color={theme.notice}>
            Low hit rate for {session.requests} requests. Usually this means the prompt prefix is
            changing between turns — check that nothing dynamic reached the system prompt, or that
            you have not been switching models mid-session.
          </Text>
        </Box>
      ) : null}

      {saved > 0.0001 ? (
        <Box paddingLeft={2}>
          <Text color={theme.toolOk}>
            Caching saved {formatCost(saved)} this session ({formatCost(session.uncachedCost)}{' '}
            uncached → {formatCost(session.cost)}).
          </Text>
        </Box>
      ) : null}

      {/* --- Totals -------------------------------------------------------- */}
      <Box marginTop={1} flexDirection="column">
        <Row label="This session" totals={session} />
        <Row label="Today" totals={today} />
        <Row label="All time" totals={allTime} />
      </Box>

      {/* --- Per model ----------------------------------------------------- */}
      {byModel.length > 1 ? (
        <Box marginTop={1} flexDirection="column">
          <Text color={theme.dim}>By model (this session):</Text>
          {byModel.map((entry) => (
            <Box key={entry.modelKey} paddingLeft={2}>
              <Text color={theme.dim}>{entry.modelKey.padEnd(30)}</Text>
              <Text>{formatCost(entry.totals.cost)}</Text>
              <Text color={theme.dim}>
                {'  '}
                {entry.totals.requests} req
              </Text>
            </Box>
          ))}
        </Box>
      ) : null}

      <Box marginTop={1} flexDirection="column">
        {hasSubscriptionModel ? (
          <Text color={theme.dim}>
            A flat-rate subscription model was used; its tokens are priced at $0 because they are
            already paid for.
          </Text>
        ) : null}
        <Text color={theme.dim}>
          Estimated from prices in models.json — providers change rates without notice. Check your
          provider dashboard for the authoritative figure.
        </Text>
      </Box>
    </Box>
  );
}

function Row({ label, totals }: { label: string; totals: UsageTotals }): React.ReactElement {
  return (
    <Box>
      <Text color={theme.dim}>{label.padEnd(14)}</Text>
      <Text bold>{formatCost(totals.cost).padEnd(12)}</Text>
      <Text color={theme.dim}>
        {formatTokens(totals.inputTokens + totals.cachedInputTokens + totals.cacheWriteTokens)} in
        {' / '}
        {formatTokens(totals.outputTokens)} out
        {'  '}
        {totals.requests} req
      </Text>
    </Box>
  );
}

function hitRateColor(rate: number, requests: number): string {
  // Don't judge a session that has barely started — the first request has
  // nothing to hit, so 0% there is correct, not a problem.
  if (requests < 3) return theme.dim;
  if (rate >= 0.5) return theme.toolOk;
  if (rate >= 0.15) return theme.notice;
  return theme.error;
}
