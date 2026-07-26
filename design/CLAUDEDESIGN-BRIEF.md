# ClaudeDesign brief — Forge desktop app

Paste everything below the line into ClaudeDesign.

---

## What you're designing

**Forge** is a desktop coding agent for Windows — an AI pair programmer that reads, writes and edits files in a real codebase, runs shell commands, and makes git commits, all under the user's supervision. Think of the Claude Code / Cursor category, but as a standalone desktop application rather than a terminal or an IDE plugin.

It's already built and working. I need you to redesign the interface so it's genuinely pleasant for long working sessions, and so the workflow around *reviewing what the agent did* stops being the weak point.

**The one distinctive thing about this product:** it's built to run on cheap models (DeepSeek, GLM, Kimi) instead of frontier ones, and it stays cheap by maximising the provider's prompt-cache hit rate. That hit-rate percentage is a first-class signal in this product, not a nerd statistic — when it's healthy (70–95%) a full working day costs under a dollar; when it collapses, cost goes up 50×. The UI needs to surface that honestly and calmly, without turning the whole app into a dashboard.

## Platform and hard constraints

**This is a DESKTOP APPLICATION. Not a mobile app, not a website.**

- Electron window on Windows 11. Default size 1180×820, resizable, minimum 720×520.
- **Do not draw a phone frame, notch, status bar, home indicator, or any device chrome.** Do not add your own window title bar, traffic lights, or close button — the OS provides those. Design only the *contents* of an application window.
- Must work in **both light and dark**, following the OS setting via `prefers-color-scheme`. The user's machine is currently in light mode, so light is not an afterthought.
- Mouse and keyboard. No touch targets, no swipe gestures.
- Content should stay readable when the window is wide — don't let text run to 1600px line lengths.

## Who uses it and how

A solo developer working on their own projects. A typical session:

1. Open the app, pick a project folder
2. Type a request in plain English — "the parser test is failing, work out why"
3. Watch the agent read files, search, and edit — usually 3–15 tool calls
4. Approve or decline anything destructive when asked
5. Read what changed, decide if it's right
6. Follow up, or move on

Sessions run from two minutes to two hours. The app is often on a second monitor while the user works in their editor.

## What exists today (improve this — don't start from zero)

**Header bar:** app name · project folder chip · "History" button · model dropdown · running cost.

**Conversation thread** (centred, max 820px) containing four kinds of item:
- *User message* — what the human typed, in a bordered box
- *Assistant message* — streamed markdown: prose, headings, lists, fenced code blocks
- *Tool call card* — a single dense line: status dot, tool name, one-line summary (`read src/parser.ts`), duration. Successful ones collapse; failures expand automatically to show the error. Edits show a `+12 −3` stat and render a unified diff inline with green/red lines.
- *Notices and errors* — inline, amber and red

**Composer** (bottom): a task checklist strip that appears when the agent is working through steps, a growing textarea, Send/Stop, and a thin status bar showing permission mode, model, context usage %, and cache hit rate %.

**Modals:** permission approval (with the exact command or a diff preview, plus Allow / Always allow / Don't allow), a usage panel, and a session history panel.

**The 13 tools it can call:** `read_file`, `write_file`, `edit_file`, `multi_edit`, `list_dir`, `glob`, `grep`, `run_shell`, `git_status`, `git_diff`, `git_log`, `git_commit`, `todo_write`.

## Problems to solve, in priority order

1. **Reviewing changes is the weak point.** After a long run the user has to scroll back through the thread to find every file that was touched. There's no summary of "here's what changed", no way to jump to a diff, no way to undo one edit without undoing everything. This is the single biggest workflow gap — solve it.

2. **Permission prompts break flow.** They're full-screen modals that block everything, including reading the message that explains why the agent wants to do it. Requests often arrive in bursts. Find a better model — inline in the thread, a queue, a quieter treatment for low-risk actions — while keeping genuinely dangerous ones (`rm -rf`, force push, `npm publish`) impossible to approve by muscle memory.

3. **No sense of what's happening during a long run.** Tool cards appear one after another; there's no progress shape, no sense of "3 of 7 steps", no way to tell a stuck agent from a thinking one. The task checklist exists but is cramped into a strip above the input.

4. **Switching projects is clumsy** — it opens a native folder dialog every time. Recent projects should be one click, and the current project should be more legible than a truncated chip.

5. **Long sessions become unnavigable.** No search, no way to jump between turns, no collapsing of earlier work.

6. **Cost and cache signals are buried** in a panel behind a click, when the cache-hit-rate number is the one thing that tells you whether the tool is working as designed. It needs an ambient presence — visible, not shouty, and legible to someone who doesn't yet know what a cache hit rate is.

7. **First-run experience doesn't exist.** If no API key is configured the app shows an error dialog. A new user needs to be walked through picking a provider, setting a key, and choosing a folder.

8. **No keyboard-first path.** Everything needs the mouse. A command palette and real shortcuts would suit this audience.

## Screens and states to deliver

Please cover:

**Core**
1. Empty state — app open on a project, no conversation yet
2. Mid-run — agent working, several tool calls done, text streaming, task list active
3. Completed run — a finished exchange including at least one file edit with a diff
4. The change-review surface you design for problem #1

**Interruptions**
5. Permission request — a routine one (edit a file) and a dangerous one (`rm -rf build`), showing how they differ
6. Error state — a failed tool call and a provider error (e.g. out of credit)

**Panels**
7. Usage / cost, with the cache-hit-rate signal
8. Session history for the current project
9. Project switcher with recent projects

**Onboarding**
10. First run — no API key configured
11. Settings — provider keys, model tiers (fast/cheap/strong), permission mode

Both light and dark for at least the core four.

## Visual direction

- **A developer tool, not a consumer app.** Calm, dense, high signal. It sits next to a code editor and shouldn't clash.
- **Please avoid the default AI-app look**: warm cream backgrounds, serif display type, purple-on-white gradients, oversized rounded cards, decorative illustration. Equally avoid generic-SaaS Inter-on-white.
- Colour should carry meaning, not decoration: green for added, red for removed or failed, amber for needs-you, neutral for everything else. If a colour doesn't mean something, don't use it.
- Code, paths, commands, diffs and numbers in a monospace face. Prose in a UI face.
- Diffs are a primary content type — they deserve real design attention, not a `<pre>` with two colours.
- Comfortable for hours: sensible line length, generous line height, no pure-black-on-pure-white or thin grey-on-grey.

## Technical constraints for the handoff

These are firm — the app runs under a strict Content-Security-Policy:

- **No external requests of any kind.** No Google Fonts, no CDN stylesheets, no remote images, no icon packs fetched at runtime. System font stacks, or describe a font and I'll bundle it.
- **No inline `<style>` or `<style>` attributes, and no inline event handlers.** CSS in a separate stylesheet, JS in a separate file. `style-src 'self'` will block anything inline.
- Icons as inline SVG, or Unicode glyphs.
- Plain HTML + CSS + vanilla JS. No React, Tailwind, or build step — it drops straight into an Electron renderer.
- Theme via CSS custom properties on `:root`, with a `prefers-color-scheme: light` block. I'm currently on `--bg`, `--surface`, `--border`, `--text`, `--text-dim`, `--accent`, `--green`, `--red`, `--amber` — feel free to redefine, just keep it variable-driven.
- Assume real content lengths: file paths that overflow, 400-line diffs, shell output with 200 lines of stack trace, a model that streams for 90 seconds. Show me how those degrade.

## Please don't

- Don't invent capabilities the app doesn't have (no multi-agent panes, no inline code editor, no voice, no collaboration).
- Don't show fabricated cost figures that imply performance — if you need numbers, sub-$0.05 sessions and 70–90% cache rates are realistic.
- Don't hide destructive actions behind pretty affordances. If something can delete a user's work, it should look like it.
- Don't design a chat app. The conversation is the mechanism; the *work* — files changed, commands run, tests passing — is the product.
