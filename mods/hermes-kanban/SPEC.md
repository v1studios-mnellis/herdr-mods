---
repo: hermes-kanban
---
# hermes-kanban — native Hermes kanban pane for herdr-app

## Goal
A packaged herdr-app mod that renders the Hermes kanban board as a native GUI
pane and lets the user edit it (full CRUD). All data comes from anton — the
always-on host — through the paired herdr-core machine `hermes`. The pane
therefore works identically from the laptop and from the desktop, even when
the laptop lid is closed. It replaces the laptop-bound `~/herdr-kanban-view`
herdr-0.9.5 plugin as the day-to-day board view.

## Requirements
- **R1 — Board pane.** One column per kanban status, canonical order `triage,
  todo, scheduled, ready, running, blocked, review, done, archived`; all
  columns unfolded by default (changed 2026-11-11: the board looked empty when
  only done/archived held cards). Cards show id, title, assignee and age. The mod opens as a pane (`pane.split {mod: "hermes-kanban"}`) and via
  `mod.open {name: "hermes-kanban"}`. `mod.json`: `place: "none"`,
  `focusable: true`, title "Hermes Kanban"; an optional key binding (suggest
  `ctrl-alt-b`, the old plugin's spirit) ships in the mod's `keys.json`.
- **R2 — Card detail on click.** Task body, comments and events from
  `hermes kanban show <id> --json` (fields `.task` / `.comments` / `.events`).
- **R3 — Live refresh.** Data timer via `cx.timer` (poll ~5–10 s, TTL-cached).
  No animation timers. Copies stay alive while hidden and their timers keep
  running, so poll gently.
- **R4 — Full CRUD through the `hermes kanban` CLI on the machine:** `create`,
  `edit`, `comment`, `assign`, status moves (`block`, `unblock`, `schedule`,
  `complete`, `request-review`, `request-changes`, `reopen-review`, `promote`,
  `archive`). Archive is the delete-equivalent. Destructive actions sit behind
  a confirm dialog.
- **R5 — Host-independent.** The pane depends only on reachability of the
  paired machine, never on laptop-local state. The machine name is
  configurable (mod props / `shared("hermes-kanban.machine")`, default
  `"hermes"` = ssh target `anton-djed`, 100.111.229.49).
- **R6 — Offline behaviour.** Machine unreachable or `exec` fails → the pane
  shows a clear offline/error state and retries on the next tick. No crash;
  no mod error in `herdr-app status`.
- **R7 — Packaging for herdr.dev.** Public GitHub repo `hermes-kanban`
  containing `mods/hermes-kanban/` plus `keys.json`, `RECIPE.md`,
  `preview.png`, with repo topic `herdr-mod`, so it lists at herdr.dev/mods.
  Install on any machine: copy the folder into `~/.config/herdr-app/mods/`,
  merge `keys.json`, run `herdr-app check`. Never overwrite an existing mod
  name.
- **R8 — Board selection.** Default board, with a `--board <slug>` passthrough
  via props for non-default boards.

## Acceptance criteria
- [ ] `herdr-app check ~/.config/herdr-app/mods/hermes-kanban` exits 0 on the laptop.
- [ ] Laptop lid closed (no herdr/herdr-app running on the laptop): on the
  desktop install the pane renders columns populated from anton. Verify with
  `herdr-app shot` + `herdr-app status` (errors empty), and compare the card
  count with `ssh anton-djed 'hermes kanban list --json --archived'`.
- [ ] Create, edit, comment, move and archive a card from the pane. Each
  change appears in `hermes kanban list --json` / `show <id> --json` on anton
  and reflects back in the pane within one poll interval, without a reload.
- [ ] Desktop install steps pass: copy `mods/hermes-kanban/` into the desktop's
  `~/.config/herdr-app/mods/`, add ssh host `anton-djed`, pair the machine in
  Settings → Machines, `herdr-app check` passes, the pane loads data.
- [ ] Machine `hermes` unpaired/unreachable: the pane shows the offline state
  and `herdr-app status` reports no mod error.
- [ ] Repo is public with `mods/hermes-kanban/`, `RECIPE.md`, `preview.png` and
  topic `herdr-mod`; the mod appears at herdr.dev/mods within the hour.
- [ ] No shipped layout or mod is modified; `~/herdr-kanban-view` stays as is.

## Constraints
- Stack: herdr-app mod in gpui-kit JS (`mods/<name>/main.js` default-exporting
  a `View`), typed against `~/.config/herdr-app/herdr.d.ts` and `gpui-kit.d.ts`
  (herdr-app 0.1.14 — these files are the truth). No DOM/HTML/CSS, no Node
  APIs, no `setTimeout`: async via `cx.spawn`, timers via `cx.timer`.
- Data access only through `exec("hermes", [...], { on: machine, timeout })` on
  the paired machine — the same CLI the old plugin used (`list --json
  --archived`, `show <id> --json`, …). The mod never opens `kanban.db`
  directly.
- Look: `theme()` colors only. Follow the shipped `triage*` mods and `redline`
  as patterns (exec on machines, `localStorage` TTL cache, `shared()` state).
- Verification loop: `herdr-app check <mod folder>` after every change
  (mandatory), `herdr-app shot` for UI checks, `herdr-app status` for errors.
- Packaging follows the herdr.dev mod rules in `~/.config/herdr-app/AGENTS.md`:
  a mod folder is `mods/<name>/` plus an optional `keys.json`; sharing adds
  `RECIPE.md` + `preview.png` + the `herdr-mod` topic.
- No secrets in the repo or the mod. Mods are trusted code; keep `exec`
  targets to the `hermes` CLI on the paired machine.
- Mod name stays `hermes-kanban` (matches the existing pane state in
  `~/.config/herdr-app/shared.json`).

## Out of scope
- Any change on anton, including the job that fails with "cannot reach
  herdr-kanban-view host 100.111.229.10 over SSH/ICMP" (job `8f0645e500e0`).
  Repointing or removing that anton-side reference is a separate task; Hermes
  config changes need Matt's approval (SOUL.md).
- Retiring or removing the old `~/herdr-kanban-view` herdr-0.9.5 plugin on the
  laptop.
- herdr 0.9.5 CLI/TUI integration, toasts/sounds for board changes, and
  drag-and-drop between columns (moves go through card actions/keys).
- The hermes-remote HTTP API on anton :9119 — not used; the CLI via the paired
  machine is the chosen source.
- Claiming/dispatching work (`claim`, `dispatch`, `daemon`, `watch`) — the
  pane manages the board; it does not run workers.
