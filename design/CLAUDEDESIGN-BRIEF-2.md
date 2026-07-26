# ClaudeDesign brief 2 — Forge, round two

Paste everything below the line into the **same** ClaudeDesign project (the one containing `Forge.dc.html` and `handoff/`).

---

## Where things stand

The first round shipped. I built the whole thing — the Working set panel, inline queued approvals with type-to-arm, the Changes panel with per-file revert, the ambient cache chip, first-run, settings, command palette. It runs as a real Electron app against a real agent.

**Since then the app has grown features the design doesn't know about**, and I've been designing them myself in code, which is exactly what I'd rather not do. This round has two jobs:

1. Finish the **speaker-identity** work you started in `Forge.dc.html`.
2. Bring the design up to date with everything that now exists, so the design and the app stop diverging.

Please update `Forge.dc.html` **and** the `handoff/` package (`index.html` / `forge.css` / `forge.js`) so the handoff stays the CSP-safe drop-in.

---

## Job 1 — Speaker identity (the main goal, already in progress)

You already made a start on this and I want it carried through:

- **You / Forge avatars** with names and timestamps, so it's never ambiguous who's talking
- **User prompts in a subtly tinted card** so they're findable when scrolling a long session
- **Forge's replies at comfortable 14px prose** with generous line-height
- **Tool cards and diffs unchanged** — they're already the strong part
- Applied consistently across **mid-run, completed, and error** states

Two additions to that, from watching real sessions:

- **A long run can put a lot of distance between a question and its answer** — 15 tool calls, several approvals, a 90-second stream. Whatever the speaker treatment is, it has to survive that distance: if I scroll back up, I should be able to find where my last message was without reading.
- **Forge speaks in several registers** in one turn: streamed prose, a short interstitial note ("Context is at 78%…"), a notice, an error. Right now those all look different. Please say which of those carry the Forge identity treatment and which are system chrome that shouldn't.

---

## Job 2 — Design the thread management that now exists

This is all **built and working** — I need designed versions of it, not invention. Where my implementation is clumsy, please improve it; where it's fine, please just formalise it so the design matches.

### 2a. Threads are created lazily

A thread row now exists **only once a message has actually been sent.** Opening the app, clicking "New session", or switching project folders creates nothing. (Before this, every launch spawned an `(untitled) · 0 msgs` row and the sidebar filled with debris.)

Design consequence: **the empty state now carries more weight** — it's what you see on every launch and every new session, not a rare first-run screen. It currently shows the project name, branch, path, and three suggestion rows. Worth a fresh look.

### 2b. Thread actions: pin, rename, archive, delete

Reachable **two ways, deliberately**: right-click anywhere on a thread row, or a **⋮ kebab that appears on hover**. (The kebab exists because right-click isn't discoverable and some people don't use it.) Both open the same menu.

Menu items, with single-key shortcuts while open:

| Action | Key | Behaviour |
|---|---|---|
| **Pin to top** / **Unpin** | `P` | Pinned threads sort above recency — a pin outranks "most recent", it doesn't tie-break it |
| **Rename** | `R` | Inline text input **in the row**, not a modal. Enter commits, Esc cancels |
| **Archive** / **Restore** | `A` | Reversible — see 2c |
| **Delete** | `D` | Two-step **inside the menu**: first click re-labels it to "Click again to delete", second click does it |

Notes for the design:

- Delete is two-step in-menu because a native `confirm()` dialog is blocked in the sandbox. If you have a better pattern for "destructive but not rare", I'm open to it — but it can't be a system dialog, and a single misclick must never destroy a transcript.
- Deleting a thread removes its transcript but **keeps its recorded spend**, so cost totals never understate what was actually paid. If that deserves surfacing anywhere, say where.
- The same menu must work in **both** the sidebar and the History sheet.

### 2c. Archive is a shelf, not a trapdoor

Archiving hides a thread from the list but keeps everything. There are currently three ways back, which is probably one too many — please rationalise:

1. An **"N archived"** button at the bottom of the sidebar thread list, shown only when the count is above zero
2. An **Active / Archived** segmented toggle in the History sheet, with a count
3. Clicking an archived thread **restores and opens it**

Archived rows carry an `ARCHIVED` tag and their menu says **Restore** instead of Archive.

### 2d. Sidebar structure as it now stands

```
New session                      Ctrl N
[search threads]

PINNED
  📌 Thread name
     time · cost · N msgs        ⋮
RECENT
  Thread name                    ⋮
  …
  🗄 3 archived

PROJECTS
  ● current-project
    other-project
  + Open folder…

Settings                         Ctrl ,
```

Every row shows time, cost, and message count. Please tell me if that's too much metadata per row — it was my call, not a designed one.

---

## What to keep exactly as-is

These are working well and shouldn't be redesigned:

- The Working set panel and its transition into the Changes panel
- Inline queued approval cards, and the type-to-arm dangerous variant
- Diff rendering
- The ambient cache chip and the Usage panel
- Command palette, first-run, Settings

---

## Constraints (unchanged, still firm)

- **Desktop application, Windows.** 1180×820 default, min 720×520. **No phone frame, notch, status bar, or window chrome** — the OS draws the title bar.
- **Both light and dark**, following the OS. My machine is in light mode, so light isn't an afterthought.
- **Strict CSP in the handoff**: no external requests at all, no inline `<style>` or `style=` attributes, no inline event handlers. Separate CSS and JS files. **JetBrains Mono must be referenced as local `fonts/*.woff2`, never fetched from Google** — a runtime fetch is blocked and silently falls back to Consolas.
- Plain HTML + CSS + vanilla JS, no build step, no framework.
- Keep the token set on `:root` (`--bg --surface --border --text --dim --faint --accent --green --red --amber` …). Colour stays semantic: green added, red removed/destructive, amber needs-you, accent activity.
- Assume **real content**: overflowing paths, 400-line diffs, 200-line stack traces, 90-second streams, thread titles far longer than the sidebar is wide.

---

## Deliverables

1. `Forge.dc.html` updated — speaker identity finished, plus the thread-management screens/states above
2. `handoff/` updated to match (CSP-safe, fonts local)
3. Both light and dark for the changed screens

New states worth their own cards: **thread menu open** (pinned vs unpinned vs archived), **delete armed**, **inline rename active**, **sidebar with a PINNED group and an archived count**, **History → Archived**.
