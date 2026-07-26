/**
 * Minimal Markdown renderer for the terminal.
 *
 * Deliberately small. A full Markdown engine (marked + a terminal renderer)
 * would add real weight and a reflow bug surface, to render constructs models
 * rarely emit in a CLI conversation. This handles what actually shows up:
 * headings, fenced code, inline code, bold/italic, lists, and blockquotes.
 *
 * Anything unrecognized falls through as plain text, which is the correct
 * failure mode — the user still reads the content.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from './theme.ts';

interface MarkdownProps {
  children: string;
}

export function Markdown({ children }: MarkdownProps): React.ReactElement {
  const blocks = splitBlocks(children);
  return (
    <Box flexDirection="column">
      {blocks.map((block, i) =>
        block.type === 'code' ? (
          <CodeBlock key={i} language={block.language} code={block.content} />
        ) : (
          <TextBlock key={i} content={block.content} />
        ),
      )}
    </Box>
  );
}

// ---------------------------------------------------------------------------

type Block =
  | { type: 'text'; content: string }
  | { type: 'code'; content: string; language: string };

/** Split on fenced code blocks; everything else is one text run. */
function splitBlocks(source: string): Block[] {
  const blocks: Block[] = [];
  const lines = source.split('\n');

  let buffer: string[] = [];
  let inCode = false;
  let language = '';
  let codeLines: string[] = [];

  const flushText = (): void => {
    if (buffer.length > 0) {
      blocks.push({ type: 'text', content: buffer.join('\n') });
      buffer = [];
    }
  };

  for (const line of lines) {
    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      if (inCode) {
        blocks.push({ type: 'code', content: codeLines.join('\n'), language });
        codeLines = [];
        inCode = false;
      } else {
        flushText();
        inCode = true;
        language = fence[1] ?? '';
      }
      continue;
    }
    if (inCode) codeLines.push(line);
    else buffer.push(line);
  }

  // An unterminated fence happens constantly with streaming output — render
  // what we have as code rather than dropping it.
  if (inCode && codeLines.length > 0) {
    blocks.push({ type: 'code', content: codeLines.join('\n'), language });
  }
  flushText();

  return blocks;
}

function CodeBlock({ code, language }: { code: string; language: string }): React.ReactElement {
  return (
    <Box flexDirection="column" marginY={1} paddingLeft={1} borderStyle="round" borderColor="gray">
      {language ? (
        <Text color={theme.dim} dimColor>
          {language}
        </Text>
      ) : null}
      {code.split('\n').map((line, i) => (
        <Text key={i} color="green">
          {line}
        </Text>
      ))}
    </Box>
  );
}

function TextBlock({ content }: { content: string }): React.ReactElement {
  const lines = content.split('\n');
  return (
    <Box flexDirection="column">
      {lines.map((line, i) => (
        <Line key={i} raw={line} />
      ))}
    </Box>
  );
}

function Line({ raw }: { raw: string }): React.ReactElement {
  // Headings — rendered bold rather than with visible '#' characters.
  const heading = /^(#{1,6})\s+(.*)$/.exec(raw);
  if (heading) {
    return (
      <Box marginTop={1}>
        <Text bold color={theme.accent}>
          {heading[2]}
        </Text>
      </Box>
    );
  }

  // Horizontal rule: three or more of -, * or _ on their own line.
  if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(raw)) {
    return <Text color={theme.dim}>{'─'.repeat(40)}</Text>;
  }

  // Blockquote.
  const quote = /^>\s?(.*)$/.exec(raw);
  if (quote) {
    return (
      <Text color={theme.dim}>
        {'│ '}
        <Inline raw={quote[1] ?? ''} />
      </Text>
    );
  }

  // Bullet list — normalize -, *, + to a single bullet glyph.
  const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(raw);
  if (bullet) {
    return (
      <Text>
        {bullet[1]}
        {'• '}
        <Inline raw={bullet[2] ?? ''} />
      </Text>
    );
  }

  // Numbered list — keep the author's numbering.
  const numbered = /^(\s*)(\d+)\.\s+(.*)$/.exec(raw);
  if (numbered) {
    return (
      <Text>
        {numbered[1]}
        <Text color={theme.dim}>{numbered[2]}. </Text>
        <Inline raw={numbered[3] ?? ''} />
      </Text>
    );
  }

  return (
    <Text>
      <Inline raw={raw} />
    </Text>
  );
}

/**
 * Inline spans: `code`, **bold**, *italic*.
 *
 * Single-pass tokenizer rather than nested regex replacement, so a code span
 * containing an asterisk isn't mangled into italics.
 */
function Inline({ raw }: { raw: string }): React.ReactElement {
  const parts: React.ReactElement[] = [];
  let index = 0;
  let key = 0;

  const pattern = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(_[^_]+_)/g;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(raw)) !== null) {
    if (match.index > index) {
      parts.push(<Text key={key++}>{raw.slice(index, match.index)}</Text>);
    }
    const token = match[0];

    if (token.startsWith('`')) {
      parts.push(
        <Text key={key++} color="green">
          {token.slice(1, -1)}
        </Text>,
      );
    } else if (token.startsWith('**')) {
      parts.push(
        <Text key={key++} bold>
          {token.slice(2, -2)}
        </Text>,
      );
    } else {
      parts.push(
        <Text key={key++} italic>
          {token.slice(1, -1)}
        </Text>,
      );
    }
    index = match.index + token.length;
  }

  if (index < raw.length) parts.push(<Text key={key++}>{raw.slice(index)}</Text>);
  if (parts.length === 0) return <Text>{raw}</Text>;
  return <>{parts}</>;
}
