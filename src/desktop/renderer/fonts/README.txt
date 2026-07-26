JetBrains Mono — bundle locally (CSP blocks runtime font fetches).

Put these four files here, from the official release zip
(https://github.com/JetBrains/JetBrainsMono -> fonts/webfonts/):

  JetBrainsMono-Regular.woff2
  JetBrainsMono-Medium.woff2
  JetBrainsMono-SemiBold.woff2
  JetBrainsMono-Bold.woff2

Until they exist, the UI falls back to Consolas (see --mono in styles.css).
License: SIL OFL 1.1 — bundling is permitted.
