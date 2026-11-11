# Previews

When a coding agent draws something (a screenshot, a mockup, a rendered page) it
saves the image into `.herdr-previews/` in the space's folder. This mod shows
those images in a drawer on the right edge of the window. Click one and a large,
draggable window opens: drop numbered pins on the image with the mouse (or draw on it with a pen, or a circle with shift), write a note on each pin, mark the draft approved, and send the annotated feedback straight
back to the space's agent with one key. A new image raises a toast and a sound.

![Previews](preview.png)

<!-- preview.png: screenshot is added by the orchestrator after install. -->

## What you see

**The rail.** A floating block docked on the right edge. Until the pointer is on
it (or you focus it with `alt-p`) it is a 36 px wide strip on `chrome`: a 16×12
rounded outline with a 5 px dot in it (`accent` when something is unread, else
`muted`), and under it a 16 px high `accent` badge with the number of unread
(`new`) images, hidden at zero. On a top or bottom edge the same rail lies
horizontally (36 px high).

**The list.** Hovered or focused, the block is 280 px wide on `chrome`, as tall
as its content up to 560 px, and scrolls. Top to bottom:

- A 32 px header: "Previews" (12 px, semibold), the space's name in `dim`
  (truncated), and on the right "N new" in `accent` (or the image count in `dim`).
- Groups. A 24 px header per group: the group name (10 px, semibold, `dim`) and
  its image count. A group is images with the same file stem: the extension and
  any trailing `-vN`/`-N`, unix timestamp (10 or 13 digits) or ISO date are
  stripped, so `homepage-v3.png` and `homepage-v2.png` are group `homepage`.
  Groups run by their newest image, newest first; images inside a group too.
  Only the 40 newest images are listed.
- Cards, 62 px high, 8 px side padding, 8 px gap: a 64×48 thumbnail (rounded 4,
  on `raised`, image contained) and, beside it, the file name (12 px,
  `foreground`, truncated) and a line with a status dot and word plus
  "N pins" in `dim` when there are pins. The selected card is on `selected`; a
  hovered one on `hover`.
- A 22 px footer in `dim`, 10 px: "alt-p to focus", or, once focused, the key
  summary; it turns `blocked`-colored with "press x again to delete <file>" while
  a delete is armed, or with the error text if listing/copying/saving failed.

Empty: "No previews yet. Agents save images to .herdr-previews/ in this space's
folder." A space without a folder says so.

On a top or bottom edge the cards lie in one 86 px high row (190 px per card).

**Status.** Every image is `new` (`accent` dot), `reviewed` (`muted`) or
`approved` (`done`). Images without a stored entry are `new`.

**The pop-out window.** 72% of the window wide, 85% high, dragged by its title bar
or any part that is not a control, remembered by herdr (key `preview`). On
`surface`, top to bottom:

- A 40 px title bar on `chrome`: file name (13 px, semibold), "draft N of M" (the
  position in its group, newest = M) or "single draft", the status chip, then on
  the right: `Compare` / `Single` (only when an older draft exists), `Approve`
  (`accent`), `Send notes`, `Close`.
- Left, on `background`: the image at its real aspect ratio, as large as fits
  (never more than 2×), centered, with a small caption above it. Each pin is a
  20 px `accent` circle with its number (11 px, `accent_foreground`), centered on
  its spot; the pin being edited has a `foreground` ring. In compare mode the
  previous (next older) draft is on the left, labeled "previous · name", and the
  current one, with its pins, on the right, "current · name".
- Right, a 250 px panel on `chrome`: "Pins (N) · tool: pin [1-2]" and two small
  tool buttons ("1 pin", "2 draw"); one row per pin (number, note,
  `dim` "no note" when empty; the selected row on `selected`); under the rows,
  the drawn strokes ("✎ pen 1", "○ circle 2", each with a ✕; strokes of the old `line` kind in a notes file are still listed as "─ line N"); then, for the selected pin, "Note for pin N · Esc to finish" and a 4-row text area
  (`background`, `input` border); finally a 10 px key hint line.

## How it behaves

**Which space.** The drawer follows the active space: it watches
`<project>/.herdr-previews/` on that space's machine (local or remote),
re-reading every 3 s. The project is the focused terminal's live folder
(`focused().cwd`), because a space's `folder` is only where its terminals start
(often home). When nothing with a folder is focused (a mod, such as the drawer
itself), it falls back to the active tab's focused pane's folder (else its first
pane's), and last to the space's `folder`. The pop-out gets the resolved project
folder in its props. Switching spaces or `cd`-ing elsewhere switches the list. The pop-out stays on the
space it was opened from. Feedback goes to the focused agent of that space, or
the first agent there; with none, a warning toast says so.

**New images.** An image path not seen before (in that space, since the mod
started; the first listing is only the baseline) raises an `info` toast
"New preview" with the file name and space, plays the `done` sound and, when the
toast is clicked, focuses the drawer (`previews.focus`). More than three at once
are folded into one toast.

**Mouse, drawer.** Click a card: it is selected, marked `reviewed` if it was
`new`, and the pop-out opens on it. While the pointer is on the block the rail is
replaced by the list; when it leaves, the rail is back.

**Mouse, pop-out.** Left click on the image drops a pin there (stored as
percentages of the image's width and height) and puts the cursor in its note.
Left click on a pin, or on its row, selects it and focuses its note. Right click
on a pin deletes it. Notes are saved when focus leaves the text area. Pressing on
the image, a pin, a button or the text area never drags the window.

**Keys, drawer.** `alt-p` (`keys.json`: `previews.focus`) moves the keyboard to
the drawer and keeps it open. Then `up`/`k`, `down`/`j` move the selection (wraps,
scrolls into view); `enter` opens the pop-out; `a` approves the selected image;
`shift-a` approves every `new` image in its group; `s` sends its notes; `x` asks
for confirmation (press again within 3 s) and deletes the file; `escape` goes to
the pane on the left (`pane.go`).

**Drawing, pop-out.** The tool is shown in the panel header and picked with keys
`1`/`p` pin (the default: a left click drops a pin) and `2`/`d` draw, or the
panel's buttons. In draw mode, press on the image, drag and release: the pen
follows the pointer; with shift held at the press it is a circle instead, an
ellipse centred on the press with the pointer's distance as its radii. There is
no line tool (too close to the pen); old `line` strokes still render and are
still sent. A stroke is drawn in `accent` (as it was when drawn). A
click without a drag draws nothing. A release outside the image also ends the
stroke. `backspace` removes the last stroke; the ✕ on a row removes that one.
Right click on a pin still deletes the pin (pressing a pin in draw mode starts
a stroke instead of selecting it).

**Keys, pop-out.** It takes the keyboard when it opens. `[` or `,` shows the
previous (older) draft of the group, `]` or `.` the next (newer); `enter` toggles
compare; `a` approve, `s` send, `x` delete (two presses; then the neighbouring
draft, or the window closes); `escape` closes. While a note is being typed all
keys type; `escape` leaves the text area first.

**Approve / send.** `Approve` sets the status to `approved` and sends; `Send` only
sends. The message pasted into the agent's terminal (with Enter, via `hc send`):

```
Feedback on draft: /abs/path/homepage-v3.png
- pin 1 at (12%, 50%): move this up
- pin 2 at (80%, 9%): no note
Drawn marks (percent of the image):
- [pen] (10%, 10%) → (12%, 14%) → …
- [line] (20%, 30%) → (60%, 30%)   (only from old drafts)
- [circle] center (50%, 50%) r (10%, 20%)

Approved: /abs/path/homepage-v3.png
```

(`Feedback…` and the pin/mark lines only when there are pins or strokes; a freehand
path is thinned to at most 12 points; `Approved:` only for
approve; several images are separated by a blank line.) Sending without pins
shows a warning toast "Nothing to send". Success is a `success` toast
("Approved homepage-v3.png", "Sent feedback on …"); failure an `error` toast.

**Persistence.** Notes live next to the images in `.herdr-previews/notes.json`:
`{ "<abs path>": { "status": "new|reviewed|approved", "pins": [{ "x", "y", "text" }], "strokes": [...] } }`.
A stroke is `{ "tool": "pen|circle|line", "color": "#hex", ... }` with percent coordinates:
pen `pts: [{x,y}]`, circle centre `c` and radii `rx`/`ry`, line `a`/`b` (read-only: the
UI no longer creates lines, old ones are kept, drawn and sent).
Every edit is applied in memory at once, then re-applied to a fresh read of the
file and written, so the drawer and the window don't overwrite each other.

**Stroke overlay.** All of an image's strokes (and the one being drawn) are one SVG,
`viewBox="0 0 100 100" preserveAspectRatio="none"`, `fill="none"`, 3 px
`vector-effect="non-scaling-stroke"` round-cap lines, shown by
`image(rel).size_full()` in an `absolute().inset_0()` div over the image and the pins
(it has no mouse handlers, so presses reach the pins and the frame). While drawing,
the file is rewritten at most every 30 ms (`SVG_THROTTLE_MS`) and the write's
`cx.notify()` is the repaint, and once more on release. Each write
is a new file `mods/previews/.cache/strokes-<hash>-<n>.svg` (n counts up; the old
versions are removed) because the renderer may cache by path. Strokes loaded from
`notes.json` get their file on the next poll (`ensureStrokes`). The drawer cards
show a "N ✎" count.

**Layout.** The floating block in the layout has no `peek`: with one, herdr clips
the block to that size until the pointer hovers, so `alt-p` could not open it. Without
it the mod's own rail/list switch (`wantOpen` while focused) sizes it.

## Built from

- `mod.json`: `{ "place": "right", "title": "Previews", "focusable": true }`,
  so herdr docks one floating copy on the right edge and `pane.go` can focus it.
- `keys.json`: `{ "global": { "alt-p": "previews.focus" } }`.
- `main.js`: `export default class Previews extends View`. `init` branches on
  `props().overlay`: the drawer copy (rail, list, key handling, new-image
  announcements) or the pop-out copy (opened with
  `openOverlay({ mod: "previews", kind: "window", key: "preview", width: 0.72,
  height: 0.85, props: { path, machine, folder, space } })`).
  - Both: `this.h = cx.focus_handle()`, `.track_focus(this.h).on_key_down(...)` on
    the root; `cx.timer.every(1000, ...)` polls on every third tick (and at once
    when the binding changes); `theme()` colors only.
  - Drawer: `placement()` (rail unless `hovered`/`dragging`/focused; `vertical`
    chooses column or row), `spaces()` (active space: `machine`, active tab, fallback `folder`), `focused()` (`cwd`), `panes()` (active tab's `cwd`),
    `agents()` (focused in that space, else first), `ScrollHandle.scroll_to_item`,
    `nextCommand()` loop for `"focus"` (`this.h.focus()`), `notify` with
    `action: { name: "previews.focus" }`, `playSound("done")`,
    `run("pane.go", { direction: "left" })`, `openOverlay`.
  - Pop-out: `closeOverlay(props().overlay)`, `TextareaState.new({ rows: 4 })`
    with `.on("change" | "focus" | "blur")`, `on_size_change` on the image area,
    `on_mouse_down("left" | "right")` with `e.local_position` / `e.bounds` and
    `cx.stop_propagation()` on every control, pins as `.absolute().left(px).top(px)`
    children of a `.relative()` frame sized to the drawn image.
- `lib.js`: `stemOf`/`groupItems` (grouping), `listImages` (`exec("find", [dir,
  "-maxdepth", "1", "-type", "f", "(", "-name", "*.png", "-o", ... ")", "-printf",
  "%T@\t%p\n"], { on: machine })`), `cachedImage`/`removeCached`/`imageSize` (see
  below), `readNotesRaw` (`readTextFile(path, { on: machine })`), `parseNotes`,
  `writeNotesText`, `strokesSvg`/`writeStrokeSvg` (overlay file), `feedbackText`, `sendToAgent` (`hc(["send", address, text])`;
  `address` is the core address, `t4` or `anton/t3`).
- Images: `image(path)` reads only below `~/.config/herdr-app`, so every shown
  image is copied to `mods/previews/.cache/<hash>-<mtime ms>.<ext>` (hidden folder,
  so saving there never reloads the mod; `.gitignore`d). Local: `fs.readFile` + `fs.writeFile`.
  Remote: `exec("sh", ["-c", 'ssh "$1" base64 -- "$2" > "$3.b64" && base64 -d
  "$3.b64" > "$3.tmp" && mv "$3.tmp" "$3"; …', "sh", machine, remotePath, dest])`
  (the machine's name is an ssh alias). A changed mtime is a new name; the older
  copy of that file is removed. Header sizes of PNG/JPEG/WebP (`sizeFromBytes`)
  give the aspect ratio, so pin percentages match the image, not its letterbox.
- Notes writes: local `writeTextFile(path, text, expectedRaw)` (optimistic lock;
  a stale snapshot is retried, three times); remote `exec("sh", ["-c", 'printf %s
  "$2" | base64 -d > "$1.tmp" && mv "$1.tmp" "$1"', "sh", path, base64], { on:
  machine })`. `writeTextFile` and `watchFolder` are local-only, hence polling
  and `exec` for remote spaces.
- Programs run: `find`, `rm` (on delete), `sh`/`ssh`/`base64`/`mv` (remote copies
  and writes), `hc send`. Nothing uses the network except through `ssh`.

## Watch out

- Pop-out windows are content-sized at first layout, so `on_size_change` can report
  ~0 height initially; the stage has min size 560x420 and `windowView` falls back to
  1000x640 until measured.
- The drawer shows a rail until hovered. Herdr sizes a floating mod to its content,
  so the mod itself renders the rail or the list from `placement().hovered`; no
  `peek` is needed in the layout. A copy focused by key stays open (`wantOpen`)
  until it loses the keyboard.
- Stroke SVGs must live in the hidden `.cache` dir and get a new versioned name
  per save: writing a file under `mods/` outside a dot-dir reloads the mod, so a
  non-hidden path would reload it on every save, mid-stroke; and a reused path may
  be served from the renderer's cache.
- Stroke width is computed from the rendered frame pixels, not left to the
  renderer: `frame()` records `this.framePx`, and `strokesSvg` uses a viewBox of
  that pixel size (percent coordinates scaled into it) with `stroke-width` 2, so a
  line is 2 px on screen on both axes. `vector-effect="non-scaling-stroke"` is not
  relied on. The SVG is rewritten when the frame size drifts more than 10%.
- Pointer coordinates are the window `position` minus the frame's `bounds`
  origin, over `bounds.width/height`. `local_position` was off from the cursor in
  live use, so don't go back to it (pin drops and strokes both use `pointAt`).
- Realtime drawing: the host does NOT hot-update an `image()`/`svg()` asset when a
  file under the hidden `.cache` dir changes on disk (verified live: an edited
  stroke SVG did not repaint without a mod-side `cx.notify()`). So each update is a
  fresh versioned file plus a notify. Every notify repaints the whole window, so
  the lever is a tight throttle: `extendStroke` updates `this.live` and, at most
  every 30 ms (`SVG_THROTTLE_MS`, timestamp check), calls `saveStrokes`, which
  writes the file and notifies. `svgBusy`/`svgDirty` serialize writes and make
  the last state land; the mouse-up always writes. Nothing else runs mid-drag:
  `poll` (no notes.json re-read) and `ensure` return early while `this.live` is
  set. The save keeps its version in memory (no readdir per write, only the
  previous file is unlinked).
- Not verified without a real mouse and window: drawing itself (the pointer
  mapping and the 2 px width were checked only by reading the code).
- `svg()` theme-tints the file with the text color, so every stroke came out one
  pale color. Use `image()` for the colored stroke overlay: it renders the SVG in
  full color (live-verified).
- `image()` paths are relative to `~/.config/herdr-app`. An absolute project path
  silently draws nothing, which is why every image is cached first.
- A local file younger than 1.5 s is not copied yet (it may still be written); the
  next 3 s poll picks it up.
- Discovery runs GNU `find -printf`, so the mod assumes Linux (GNU findutils) on the
  local machine and on any remote one; on macOS/BSD the poll finds nothing.
- The mod sandbox's `fs/promises` exposes only `mkdir`/`readdir`/`unlink`/`readFile`/
  `writeFile` (no `stat`/`copyFile`/`rename`/`cp`); copies are `readFile` + `writeFile`,
  and "exists" is a `readdir` check.
- Module top level has no side effects (herdr reloads the module on every save).
  No `setTimeout`; no `cx` is kept across callbacks. Text areas are made in `init`,
  never in `render`.
- A press the mod doesn't stop drags a window, so every clickable thing in the
  pop-out stops its `left` mouse down; the title bar and empty panel areas don't.
- Keystroke names are matched as herdr reports them: `shift-a`, `escape`, `[`,
  `,`. Plain letters only act while no note is being typed.
- The key action is `previews.focus` (`<mod>.<command>`); the `mod:command` form
  in the `nextCommand` doc comment would run a command named `previews`.
- At most 40 images are listed and copied; a space's folder that is empty ("home")
  has no previews. Notes are matched to images by absolute path, so renaming or
  moving a folder starts the statuses over. Deleting a file leaves no trash.
- Concurrent edits to one notes file are merged by re-applying the edit; pin edits
  are by index, so two people deleting pins on one image at once can misfire.
- Not interactively tested here: `herdr-app check` loads and renders once; the
  async paths (polling, copying, `hc send`) need a running window.

## Done when

- `herdr-app check mods/previews` exits 0.
- With a PNG saved into `<space folder>/.herdr-previews/`, within 3 s the rail's
  badge shows 1, a toast "New preview" appears with the `done` sound, and
  hovering the rail shows a card with its thumbnail, name and a `new` dot.
- Clicking the card opens the pop-out with the full image and the card turns
  `reviewed`; clicking the image adds a numbered pin where you clicked and
  focuses a note; typing a note and pressing `escape` stores it in `notes.json`
  as percentages; right-clicking the pin removes it.
- `Send notes` pastes `Feedback on draft: <path>` and a `- pin N at (x%, y%): text`
  line per pin into the space's focused agent and shows a success toast;
  `Approve` also adds `Approved: <path>` and turns the status to `approved`.
- Saving `name-v2.png` next to `name-v1.png` puts both in group `name`; `[`/`]` in
  the pop-out move between them and `Compare` shows the older on the left.
- `alt-p` focuses the drawer; `j`/`k` move, `x` `x` deletes the file, `escape`
  returns to the pane on the left.
- In a space on another machine the same works (copies over ssh, notes written
  with `exec`).
