/**
 * Permission prompt.
 *
 * Single-keypress, because this appears often enough that a prompt requiring
 * Enter would be genuinely annoying — and an annoying prompt is one people stop
 * reading, which defeats the point of having it.
 *
 * "Always" is deliberately not offered for dangerous commands. Remembering
 * "yes, always run rm -rf" is not a decision anyone should be able to make with
 * one keystroke while half-focused.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import { theme } from './theme.ts';
import { DiffView } from './components.tsx';
import type { PermissionDecision, PermissionRequest } from '../tools/types.ts';

interface ConfirmProps {
  request: PermissionRequest;
  onDecide: (decision: PermissionDecision) => void;
}

export function Confirm({ request, onDecide }: ConfirmProps): React.ReactElement {
  const isDangerous = Boolean(request.danger);

  useInput((input, key) => {
    const ch = input.toLowerCase();
    if (ch === 'y') onDecide({ type: 'allow' });
    else if (ch === 'a' && !isDangerous) onDecide({ type: 'allow_always' });
    else if (ch === 'n' || key.escape) onDecide({ type: 'deny' });
  });

  return (
    <Box
      flexDirection="column"
      marginY={1}
      paddingX={1}
      borderStyle="round"
      borderColor={isDangerous ? theme.error : theme.notice}
    >
      <Text bold color={isDangerous ? theme.error : theme.notice}>
        {request.title}
      </Text>

      <Box marginTop={1} flexDirection="column">
        {request.detail.split('\n').map((line, i) => (
          <Text key={i}>{line}</Text>
        ))}
      </Box>

      {request.danger ? (
        <Box marginTop={1}>
          <Text color={theme.error} bold>
            ⚠ {request.danger}
          </Text>
        </Box>
      ) : null}

      {request.display?.kind === 'diff' ? <DiffView display={request.display} /> : null}

      <Box marginTop={1}>
        <Text color={theme.dim}>
          <Text color={theme.toolOk} bold>
            y
          </Text>
          {' allow  '}
          {!isDangerous ? (
            <>
              <Text color={theme.toolOk} bold>
                a
              </Text>
              {' always allow this  '}
            </>
          ) : null}
          <Text color={theme.error} bold>
            n
          </Text>
          {' deny (esc)'}
        </Text>
      </Box>
    </Box>
  );
}
