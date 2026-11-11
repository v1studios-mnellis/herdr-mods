// Previews: images an agent saves into <project folder>/.herdr-previews/ show up
// in a floating right-edge drawer. A card opens a draggable pop-out window with
// the big image, mouse pins with notes, a status per image and a one-key send
// of the annotated feedback to the space's agent (`hc send`).
//
// One file, two modes: the docked copy is the drawer; `props().overlay` is set
// in the pop-out window that openOverlay({ mod: "previews" }) makes.

import { View, div, image } from "gpui-kit";
import { v_flex, h_flex, TextareaState, Textarea, ScrollHandle } from "gpui-base";
import { agents, spaces, panes, focused, props, theme, run, exec, notify, playSound, openOverlay, closeOverlay, nextCommand, placement } from "herdr";
import {
  baseName, stemOf, groupItems, listImages, cachedImage, removeCached, imageSize,
  readNotesRaw, parseNotes, writeNotesText, writeStrokeSvg, feedbackText, sendToAgent,
} from "./lib.js";

const MOD = "previews";
const POLL_TICKS = 3; // the timer ticks every second; a poll is every third
const AWAY = { right: "left", left: "right", top: "down", bottom: "up" }; // pane.go away from a drawer edge
const CONFIRM_MS = 3000; // second press of x within this deletes
const RAIL_W = 36;
const LIST_W = 280;
const LIST_MAX_H = 560;
const HEAD_H = 24; // group header row
const CARD_H = 62;
const THUMB_W = 64;
const THUMB_H = 48;
const PANEL_W = 250; // pop-out: pins and notes
const PAD = 12;
const SVG_THROTTLE_MS = 150; // live stroke: how often the overlay SVG is rewritten
const TOOLS = [
  { id: "pin", name: "pin", keys: ["1", "p"] },
  { id: "pen", name: "pen", keys: ["2", "f"] },
  { id: "line", name: "line", keys: ["3", "l"] },
  { id: "circle", name: "circle", keys: ["4", "c"] },
];
const STROKE_ICON = { pen: "✎", line: "─", circle: "○" };

const message = (e) => String(e?.message ?? e);
const onMachine = (machine) => (machine ? { on: machine } : {});
const entryOf = (notes, path) => {
  const e = notes[path] ?? (notes[path] = { status: "new", pins: [], strokes: [] });
  if (!Array.isArray(e.pins)) e.pins = [];
  if (!Array.isArray(e.strokes)) e.strokes = [];
  return e;
};
// "shift-a" whether the platform reports the key as "a" or "A".
const keyName = (e) => (e.modifiers?.shift && /^[a-z]$/i.test(e.key ?? "") ? `shift-${e.key.toLowerCase()}` : e.keystroke);
const round1 = (n) => Math.round(Math.min(100, Math.max(0, n)) * 10) / 10;

export default class Previews extends View {
  init(_props, cx) {
    this.h = cx.focus_handle();
    this.overlay = props()?.overlay ?? null;
    this.items = [];
    this.notes = {};
    this.notesRaw = null;
    this.rel = new Map(); // path -> { rel, mtime, retry?, error? } copied under appHome
    this.dims = new Map(); // rel -> { w, h }
    this.queue = []; // notes edits waiting to be written
    this.flushing = false;
    this.error = null;
    this.armed = null; // { path, at }: x pressed once
    this.bkey = null;
    this.bind = null;
    this.tick = 0;
    this.strokeSvg = new Map(); // path -> { rel }: the stroke overlay SVG under appHome
    this.svgBusy = new Set(); // paths whose SVG is being written
    this.svgDirty = new Set(); // ... and asked to be written again afterwards
    this.svgAt = 0;
    this.framePx = null; // { w, h }: the annotated frame's rendered size in px
    this.tool = "pin";
    this.live = null; // { path, stroke }: the stroke being drawn

    if (this.overlay) {
      const p = props();
      this.path = p.path;
      this.fixed = { folder: p.folder ?? "", machine: p.machine ?? null, space: p.space ?? null };
      this.compare = false;
      this.editing = null; // pin index in the note editor
      this.noteFocus = false;
      this.noteDirty = false;
      this.area = { width: 0, height: 0 };
      this.note = TextareaState.new({ rows: 4, placeholder: "What should change here?" });
      this.note.on("change", (_e, cx) => {
        const pin = this.notes[this.path]?.pins?.[this.editing];
        if (!pin) return;
        pin.text = this.note.value();
        this.noteDirty = true;
        cx.notify();
      });
      this.note.on("focus", (_e, cx) => {
        this.noteFocus = true;
        cx.notify();
      });
      this.note.on("blur", (_e, cx) => {
        this.noteFocus = false;
        this.commitNote(cx);
        cx.notify();
      });
      this.h.focus();
      this.rebind();
      this.markReviewed(cx, this.path);
    } else {
      this.scroll = ScrollHandle.new();
      this.sel = null;
      this.seen = new Map(); // binding -> paths already announced
      this.wantOpen = false; // opened by key: show the list even when not hovered
      this.focusAt = 0;
      cx.spawn(async (cx) => {
        for (;;) {
          try {
            const c = await nextCommand();
            if (c === "focus") {
              this.wantOpen = true;
              this.focusAt = Date.now();
              this.h.focus();
            }
          } catch {}
          cx.notify();
        }
      });
    }

    this.step(cx, true);
    cx.timer.every(1000, (cx) => this.step(cx, false));
  }

  // ---- binding ------------------------------------------------------------

  // The drawer follows the active space; the window is pinned to the one it
  // was opened from.
  binding() {
    const all = spaces();
    let s;
    if (this.overlay) {
      const f = this.fixed;
      s = all.find((x) => x.id === f.space) ?? all.find((x) => x.folder === f.folder && (x.machine ?? null) === f.machine);
      return { key: `${f.machine ?? ""}|${f.folder}`, folder: f.folder, machine: f.machine, spaceId: s?.id ?? f.space, spaceName: s?.name ?? "" };
    }
    s = all.find((x) => x.active);
    if (!s) return null;
    const folder = this.projectRoot(s);
    return { key: `${s.machine ?? ""}|${folder}`, folder, machine: s.machine ?? null, spaceId: s.id, spaceName: s.name };
  }

  // The project is where the focused terminal is, not where the space's
  // terminals started: focused cwd, else the active tab's focused (or first)
  // pane, else the space's folder.
  projectRoot(s) {
    const cwd = focused()?.cwd;
    if (cwd) return cwd;
    const tab = s.tabs.find((t) => t.active);
    if (tab) {
      const ps = panes().filter((p) => p.tab === tab.id && p.cwd);
      const p = ps.find((x) => x.focused) ?? ps[0];
      if (p) return p.cwd;
    }
    return s.folder;
  }

  rebind() {
    const b = this.binding();
    this.bind = b;
    const key = b?.key ?? null;
    if (key === this.bkey) return false;
    this.bkey = key;
    this.items = [];
    this.notes = {};
    this.notesRaw = null;
    this.rel = new Map();
    this.strokeSvg = new Map();
    this.live = null;
    this.queue = [];
    this.error = null;
    this.armed = null;
    if (!this.overlay) this.sel = null;
    return true;
  }

  step(cx, first) {
    const changed = this.rebind();
    if (!this.overlay && this.wantOpen && !this.h.is_focused() && Date.now() - this.focusAt > 1500) {
      this.wantOpen = false;
      cx.notify();
    }
    if (first || changed || ++this.tick % POLL_TICKS === 0) this.poll(cx);
  }

  // ---- data ---------------------------------------------------------------

  async poll(cx) {
    const b = this.bind;
    if (this.polling) return;
    if (!b || !b.folder) {
      this.items = [];
      cx.notify();
      return;
    }
    this.polling = true;
    try {
      const items = await listImages(b.folder, b.machine);
      const raw = await readNotesRaw(b.folder, b.machine);
      if (this.bind?.key !== b.key) return;
      this.error = null;
      this.items = items;
      if (!this.noteDirty && !this.flushing && !this.queue.length) {
        this.notes = parseNotes(raw);
        this.notesRaw = raw;
      }
      this.announce(b, items);
      if (!this.overlay && !items.some((i) => i.path === this.sel)) this.sel = this.flat()[0]?.path ?? null;
      cx.notify();
      this.ensure(cx);
    } catch (e) {
      this.error = message(e);
      cx.notify();
    } finally {
      this.polling = false;
    }
  }

  // A path this copy hasn't seen in this binding is new. The first listing of a
  // binding is the baseline, so opening the app doesn't announce old files.
  announce(b, items) {
    if (this.overlay) return;
    const seen = this.seen.get(b.key);
    if (!seen) {
      this.seen.set(b.key, new Set(items.map((i) => i.path)));
      return;
    }
    const fresh = items.filter((i) => !seen.has(i.path));
    for (const i of fresh) seen.add(i.path);
    const action = { name: `${MOD}.focus` };
    for (const i of fresh.slice(0, 3)) {
      notify({ title: "New preview", body: b.spaceName ? `${i.name} · ${b.spaceName}` : i.name, level: "info", action });
    }
    if (fresh.length > 3) notify({ title: `${fresh.length - 3} more new previews`, level: "info", action });
    if (fresh.length) playSound("done");
  }

  // What to copy under appHome, most wanted first.
  wanted() {
    if (!this.overlay) return this.items;
    const g = this.group();
    const i = g.findIndex((x) => x.path === this.path);
    const first = [g[i], g[i + 1]].filter(Boolean);
    return [...first, ...g.filter((x) => !first.includes(x))];
  }

  async ensure(cx) {
    this.ensureStrokes(cx);
    if (this.caching) {
      this.recache = true;
      return;
    }
    this.caching = true;
    try {
      do {
        this.recache = false;
        const b = this.bind;
        if (!b) break;
        for (const item of this.wanted()) {
          const cur = this.rel.get(item.path);
          if (cur && cur.mtime === item.mtime && (cur.rel || Date.now() < cur.retry)) continue;
          try {
            const rel = await cachedImage(item, b.machine);
            if (rel) {
              if (this.overlay && !this.dims.has(rel)) this.dims.set(rel, await imageSize(rel));
              this.rel.set(item.path, { rel, mtime: item.mtime });
              cx.notify();
            }
          } catch (e) {
            this.rel.set(item.path, { rel: null, mtime: item.mtime, retry: Date.now() + 30000, error: message(e) });
            this.error = message(e);
            cx.notify();
          }
          if (this.bind?.key !== b.key) break;
        }
      } while (this.recache);
    } finally {
      this.caching = false;
    }
  }

  statusOf(path) {
    return this.notes[path]?.status ?? "new";
  }

  pinsOf(path) {
    return this.notes[path]?.pins ?? [];
  }

  strokesOf(path) {
    return this.notes[path]?.strokes ?? [];
  }

  // ---- stroke overlay SVG ---------------------------------------------------

  // The committed strokes of an image plus the one being drawn on it.
  drawn(path) {
    const list = [...this.strokesOf(path)];
    if (this.live?.path === path) list.push(this.live.stroke);
    return list;
  }

  // Loaded strokes that have no overlay file yet (after a start or a poll).
  ensureStrokes(cx) {
    if (!this.overlay) return;
    for (const item of this.wanted()) {
      if (this.strokesOf(item.path).length && !this.svgBusy.has(item.path) && this.strokeStale(item.path)) this.saveStrokes(cx, item.path);
    }
  }

  // No overlay file yet, or it was drawn for a frame size >10% off the current one.
  strokeStale(path) {
    const have = this.strokeSvg.get(path);
    if (!have) return true;
    const now = this.framePx;
    if (!now || !have.px) return false;
    return Math.abs(now.w - have.px.w) > have.px.w * 0.1 || Math.abs(now.h - have.px.h) > have.px.h * 0.1;
  }

  // Writes the overlay SVG for `path` (a write asked for while one runs is
  // done once more afterwards, so the last state always lands).
  saveStrokes(cx, path) {
    const b = this.bind;
    if (!b) return;
    if (this.svgBusy.has(path)) {
      this.svgDirty.add(path);
      return;
    }
    this.svgBusy.add(path);
    cx.spawn(async (cx) => {
      try {
        do {
          this.svgDirty.delete(path);
          const px = this.framePx;
          const rel = await writeStrokeSvg(b.machine, path, this.drawn(path), px);
          if (rel) this.strokeSvg.set(path, { rel, px });
          else this.strokeSvg.delete(path);
          cx.notify();
        } while (this.svgDirty.has(path));
      } catch (e) {
        this.error = `strokes not drawn: ${message(e)}`;
      } finally {
        this.svgBusy.delete(path);
        cx.notify();
      }
    });
  }

  setTool(cx, tool) {
    this.finishStroke(cx);
    this.tool = tool;
    cx.notify();
  }

  pointAt(e) {
    // Window position minus the frame's origin: local_position was seen off from the cursor.
    if (!e.position || !e.bounds || !e.bounds.width || !e.bounds.height) return null;
    const { x: bx = 0, y: by = 0, width, height } = e.bounds;
    return { x: round1(((e.position.x - bx) / width) * 100), y: round1(((e.position.y - by) / height) * 100) };
  }

  startStroke(cx, path, e) {
    const p = this.pointAt(e);
    if (!p) return;
    this.commitNote(cx);
    const color = theme().accent;
    const stroke =
      this.tool === "pen" ? { tool: "pen", color, pts: [p] }
      : this.tool === "line" ? { tool: "line", color, a: p, b: p }
      : { tool: "circle", color, c: p, rx: 0, ry: 0 };
    this.live = { path, stroke };
    this.svgAt = Date.now();
    this.saveStrokes(cx, path);
  }

  // Moves the live stroke to the pointer; the SVG is rewritten at most every 150 ms.
  extendStroke(cx, e) {
    const s = this.live?.stroke;
    const p = s && this.pointAt(e);
    if (!p) return;
    if (s.tool === "pen") {
      const last = s.pts[s.pts.length - 1];
      if (Math.abs(p.x - last.x) < 0.2 && Math.abs(p.y - last.y) < 0.2) return;
      s.pts.push(p);
    } else if (s.tool === "line") {
      s.b = p;
    } else {
      s.rx = round1(Math.abs(p.x - s.c.x));
      s.ry = round1(Math.abs(p.y - s.c.y));
    }
    if (Date.now() - this.svgAt >= SVG_THROTTLE_MS) {
      this.svgAt = Date.now();
      this.saveStrokes(cx, this.live.path);
    }
  }

  // Mouse up: the live stroke is kept (when it has some extent) and the SVG written.
  finishStroke(cx, e) {
    if (!this.live) return;
    if (e) this.extendStroke(cx, e);
    const { path, stroke: s } = this.live;
    this.live = null;
    const keep =
      s.tool === "pen" ? s.pts.length > 1
      : s.tool === "line" ? s.a.x !== s.b.x || s.a.y !== s.b.y
      : s.rx > 0 || s.ry > 0;
    if (keep) {
      this.update(cx, (n) => {
        entryOf(n, path).strokes.push(s);
      });
    }
    this.saveStrokes(cx, path);
    cx.notify();
  }

  deleteStroke(cx, i) {
    const path = this.path;
    if (!this.strokesOf(path)[i]) return;
    this.update(cx, (n) => {
      n[path]?.strokes?.splice(i, 1);
    });
    this.saveStrokes(cx, path);
  }

  // Edit the notes: at once in memory, then on disk against a fresh read (so
  // the drawer and a window editing the same file don't overwrite each other).
  update(cx, fn) {
    if (!this.bind?.folder) return;
    fn(this.notes);
    this.queue.push({ b: this.bind, fn });
    cx.notify();
    if (!this.flushing) {
      this.flushing = true;
      cx.spawn((cx) => this.flush(cx));
    }
  }

  async flush(cx) {
    try {
      while (this.queue.length) {
        const { b, fn } = this.queue.shift();
        await this.persist(b, fn);
      }
    } catch (e) {
      this.queue = [];
      this.error = `notes not saved: ${message(e)}`;
    } finally {
      this.flushing = false;
      cx.notify();
    }
  }

  async persist(b, fn) {
    for (let attempt = 0; ; attempt++) {
      const raw = await readNotesRaw(b.folder, b.machine);
      const notes = parseNotes(raw);
      fn(notes);
      const text = JSON.stringify(notes, null, 2);
      try {
        await writeNotesText(b.folder, b.machine, text, raw);
      } catch (e) {
        if (attempt >= 2) throw e; // the file changed under us: read and apply again
        continue;
      }
      if (this.bind?.key === b.key) {
        this.notesRaw = text;
        if (!this.queue.length && !this.noteDirty) this.notes = notes;
      }
      return;
    }
  }

  markReviewed(cx, path) {
    if (this.statusOf(path) !== "new") return;
    this.update(cx, (n) => {
      const e = entryOf(n, path);
      if (e.status === "new") e.status = "reviewed";
    });
  }

  // ---- ordering -----------------------------------------------------------

  groups() {
    return groupItems(this.items);
  }

  flat() {
    return this.groups().flatMap((g) => g.items);
  }

  // The drafts of the current image's stem, newest first.
  group() {
    const stem = stemOf(this.path);
    return this.items.filter((i) => i.stem === stem).sort((a, b) => b.mtime - a.mtime);
  }

  unread() {
    return this.items.filter((i) => this.statusOf(i.path) === "new").length;
  }

  // ---- actions ------------------------------------------------------------

  agent() {
    const id = this.bind?.spaceId;
    if (!id) return null;
    const list = agents().filter((a) => a.space === id);
    return list.find((a) => a.focused) ?? list[0] ?? null;
  }

  // `onSent` runs only once the agent has received the message.
  send(cx, blocks, done, onSent) {
    const text = feedbackText(blocks);
    if (!text) {
      notify({ title: "Nothing to send", body: "Drop a pin or draw on the image first.", level: "warning" });
      return;
    }
    const agent = this.agent();
    if (!agent) {
      notify({ title: "No agent in this space", body: "Start one to send feedback to.", level: "warning" });
      return;
    }
    cx.spawn(async (cx) => {
      try {
        await sendToAgent(agent.address, text);
        onSent?.(cx);
        notify({ title: done, level: "success" });
      } catch (e) {
        notify({ title: "Could not send feedback", body: message(e), level: "error" });
      }
      cx.notify();
    });
  }

  sendNotes(cx, item) {
    if (!item) return;
    this.commitNote(cx);
    this.send(cx, [{ path: item.path, pins: this.pinsOf(item.path), strokes: this.strokesOf(item.path), approve: false }], `Sent feedback on ${item.name}`);
  }

  approve(cx, list) {
    if (!list.length) return;
    this.commitNote(cx);
    const blocks = list.map((i) => ({ path: i.path, pins: this.pinsOf(i.path), strokes: this.strokesOf(i.path), approve: true }));
    // Marked approved only after the agent has heard it; on failure the status stays.
    this.send(cx, blocks, list.length > 1 ? `Approved ${list.length} drafts` : `Approved ${list[0].name}`, (cx) =>
      this.update(cx, (n) => {
        for (const i of list) entryOf(n, i.path).status = "approved";
      }),
    );
  }

  // Two presses of x within three seconds; `after` runs once the file is gone.
  remove(cx, item, after) {
    if (!item) return;
    if (this.armed?.path !== item.path || Date.now() - this.armed.at > CONFIRM_MS) {
      this.armed = { path: item.path, at: Date.now() };
      cx.notify();
      return;
    }
    this.armed = null;
    const b = this.bind;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("rm", ["--", item.path], onMachine(b.machine));
        if (r.code !== 0) throw new Error(r.stderr.trim() || "rm failed");
        const cached = this.rel.get(item.path)?.rel;
        if (cached) removeCached(cached);
        this.rel.delete(item.path);
        this.strokeSvg.delete(item.path);
        writeStrokeSvg(b.machine, item.path, []).catch(() => {});
        this.items = this.items.filter((i) => i.path !== item.path);
        this.update(cx, (n) => {
          delete n[item.path];
        });
        after?.(cx);
      } catch (e) {
        notify({ title: "Could not delete", body: message(e), level: "error" });
      }
      cx.notify();
    });
  }

  // ---- drawer ---------------------------------------------------------------

  popout(cx, item) {
    this.sel = item.path;
    this.markReviewed(cx, item.path);
    openOverlay({
      mod: MOD,
      kind: "window",
      key: "preview",
      width: 0.72,
      height: 0.85,
      props: { path: item.path, machine: this.bind?.machine ?? null, folder: this.bind?.folder ?? "", space: this.bind?.spaceId ?? null },
    });
    cx.notify();
  }

  move(cx, delta) {
    const flat = this.flat();
    if (!flat.length) return;
    const i = flat.findIndex((x) => x.path === this.sel);
    const next = flat[(((i < 0 ? 0 : i + delta) % flat.length) + flat.length) % flat.length];
    this.sel = next.path;
    // Horizontal placement renders cards only, so index over what the container holds.
    const vertical = placement()?.vertical ?? true;
    const row = this.rows()
      .filter((r) => vertical || r.item)
      .findIndex((r) => r.item?.path === next.path);
    if (row >= 0) this.scroll.scroll_to_item(row);
    cx.notify();
  }

  rows() {
    const rows = [];
    for (const g of this.groups()) {
      rows.push({ head: g });
      for (const item of g.items) rows.push({ item });
    }
    return rows;
  }

  drawerKey(e, cx) {
    const sel = this.items.find((i) => i.path === this.sel);
    switch (keyName(e)) {
      case "up":
      case "k":
        this.move(cx, -1);
        break;
      case "down":
      case "j":
        this.move(cx, 1);
        break;
      case "enter":
        if (sel) this.popout(cx, sel);
        break;
      case "a":
        if (sel) this.approve(cx, [sel]);
        break;
      case "shift-a": {
        const g = sel ? this.groups().find((x) => x.stem === sel.stem) : null;
        this.approve(cx, g ? g.items.filter((i) => this.statusOf(i.path) === "new") : []);
        break;
      }
      case "s":
        this.sendNotes(cx, sel);
        break;
      case "x":
        this.remove(cx, sel, () => {
          this.sel = this.flat()[0]?.path ?? null;
        });
        break;
      case "escape":
        this.wantOpen = false;
        run("pane.go", { direction: AWAY[placement()?.edge] ?? "left" }); // away from the drawer's edge
        cx.notify();
        break;
      default:
        return;
    }
    cx.stop_propagation();
  }

  render(cx) {
    return this.overlay ? this.windowView(theme(), cx) : this.drawerView(theme(), cx);
  }

  statusColors(t) {
    return { new: t.accent, reviewed: t.muted, approved: t.done };
  }

  statusChip(t, status) {
    const color = this.statusColors(t)[status] ?? t.muted;
    return h_flex().items_center().gap(5).flex_none()
      .child(div().size(7).rounded(4).bg(color))
      .child(div().text_size(11).text_color(color).child(status));
  }

  thumb(t, item) {
    const rel = this.rel.get(item.path)?.rel;
    return div().w(THUMB_W).h(THUMB_H).flex_none().rounded(4).bg(t.raised).overflow_hidden()
      .when(rel, (el) => el.child(image(rel).size_full()));
  }

  card(t, item, selected, width) {
    const pins = this.pinsOf(item.path).length;
    const marks = this.strokesOf(item.path).length;
    return h_flex()
      .id(`card-${item.path}`)
      .h(CARD_H).items_center().gap(8).px(8)
      .when(width, (el) => el.w(width).flex_none())
      .bg(selected ? t.selected : t.chrome)
      .hover((s) => s.bg(selected ? t.selected : t.hover))
      .cursor_pointer()
      .on_click((_e, cx) => this.popout(cx, item))
      .child(this.thumb(t, item))
      .child(
        v_flex().flex_1().min_w(0).gap(3)
          .child(div().text_size(12).text_color(t.foreground).truncate().child(item.name))
          .child(
            h_flex().items_center().gap(6)
              .child(this.statusChip(t, this.statusOf(item.path)))
              .when(pins > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${pins} pin${pins === 1 ? "" : "s"}`)))
              .when(marks > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(`${marks} ✎`))),
          ),
      );
  }

  rail(t, unread, vertical) {
    const color = unread ? t.accent : t.muted;
    return (vertical ? v_flex() : h_flex())
      .items_center().justify_center().gap(6).p(8)
      .when(vertical, (el) => el.w(RAIL_W).py(10))
      .when(!vertical, (el) => el.h(RAIL_W).px(10))
      .child(
        h_flex().w(16).h(12).items_center().justify_center().rounded(3).border_1().border_color(color)
          .child(div().size(5).rounded(3).bg(color)),
      )
      .when(unread > 0, (el) =>
        el.child(
          h_flex().min_w(16).h(16).px(4).items_center().justify_center().rounded(8)
            .bg(t.accent).text_color(t.accent_foreground).text_size(10).font_semibold()
            .child(String(unread)),
        ),
      );
  }

  drawerView(t, cx) {
    const pl = placement();
    const floating = Boolean(pl);
    const vertical = pl ? pl.vertical : true;
    if (!this.overlay && !this.bind) this.rebind();
    const unread = this.unread();
    const open = !floating || pl.hovered || pl.dragging || this.wantOpen;

    const root = (vertical ? v_flex() : h_flex())
      .id("previews-root")
      .track_focus(this.h)
      .on_key_down((e, cx) => this.drawerKey(e, cx))
      .bg(t.chrome).text_color(t.foreground).text_size(12);

    if (!open) return root.child(this.rail(t, unread, vertical));

    const rows = this.rows();
    const armed = this.armed && Date.now() - this.armed.at <= CONFIRM_MS ? this.armed : null;
    const listH = rows.reduce((n, r) => n + (r.head ? HEAD_H : CARD_H), 0);

    const header = h_flex().h(32).flex_none().items_center().gap(6).px(10)
      .child(div().text_size(12).font_semibold().child("Previews"))
      .child(div().flex_1().min_w(0).text_size(11).text_color(t.dim).truncate().child(this.bind?.spaceName ?? ""))
      .child(div().text_size(11).text_color(unread ? t.accent : t.dim).child(unread ? `${unread} new` : `${this.items.length}`));

    const hint = armed
      ? { text: `press x again to delete ${baseName(armed.path)}`, color: t.blocked }
      : this.error
        ? { text: this.error, color: t.blocked }
        : { text: this.wantOpen ? "j/k ⏎ open · a approve · s send · x delete" : "alt-p to focus", color: t.dim };
    const footer = div().h(22).flex_none().px(10).flex().items_center().text_size(10).text_color(hint.color).truncate().child(hint.text);

    const empty = div().p(14).text_size(11).text_color(t.dim)
      .child(this.bind?.folder ? "No previews yet. Agents save images to .herdr-previews/ in this space's folder." : "This space has no folder.");

    if (!vertical) {
      return root
        .when(floating, (el) => el.h(86).w(Math.min(720, 120 + this.items.length * 196)))
        .when(!floating, (el) => el.size_full())
        .child(
          h_flex().id("previews-list").flex_1().min_w(0).items_center().overflow_x_scrollbar().track_scroll(this.scroll)
            .children(rows.filter((r) => r.item).map((r) => this.card(t, r.item, r.item.path === this.sel, 190)))
            .when(!rows.length, (el) => el.child(empty)),
        )
        .child(footer);
    }

    const height = Math.min(LIST_MAX_H, 32 + Math.max(listH, 70) + 22 + 10);
    return root
      .when(floating, (el) => el.w(LIST_W).h(height))
      .when(!floating, (el) => el.size_full())
      .child(header)
      .child(
        v_flex().id("previews-list").flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
          .children(
            rows.map((r) =>
              r.head
                ? h_flex().h(HEAD_H).flex_none().items_center().gap(6).px(10)
                  .child(div().flex_1().min_w(0).text_size(10).font_semibold().text_color(t.dim).truncate().child(r.head.stem))
                  .child(div().text_size(10).text_color(t.dim).child(String(r.head.items.length)))
                : this.card(t, r.item, r.item.path === this.sel, 0),
            ),
          )
          .when(!rows.length, (el) => el.child(empty)),
      )
      .child(footer);
  }

  // ---- pop-out window -------------------------------------------------------

  current() {
    return this.items.find((i) => i.path === this.path) ?? { path: this.path, name: baseName(this.path ?? ""), stem: stemOf(this.path ?? ""), mtime: 0 };
  }

  goto(cx, item) {
    if (!item) return;
    this.commitNote(cx);
    this.finishStroke(cx);
    this.path = item.path;
    this.editing = null;
    this.armed = null;
    this.markReviewed(cx, item.path);
    this.ensure(cx);
    cx.notify();
  }

  // Older/newer draft of the same stem.
  step_(cx, delta) {
    const g = this.group();
    const i = g.findIndex((x) => x.path === this.path);
    this.goto(cx, g[i + delta]);
  }

  commitNote(cx) {
    if (!this.overlay || this.editing == null || !this.noteDirty) return;
    const text = this.note.value();
    const i = this.editing;
    const path = this.path;
    this.noteDirty = false;
    this.update(cx, (n) => {
      const pin = n[path]?.pins?.[i];
      if (pin) pin.text = text;
    });
  }

  selectPin(cx, i) {
    if (this.editing !== i) this.commitNote(cx);
    this.editing = i;
    this.noteDirty = false;
    this.note.set_value(this.pinsOf(this.path)[i]?.text ?? "");
    this.note.focus();
    cx.notify();
  }

  addPin(cx, x, y) {
    this.commitNote(cx);
    const path = this.path;
    const index = this.pinsOf(path).length;
    this.update(cx, (n) => {
      entryOf(n, path).pins.push({ x, y, text: "" });
    });
    this.selectPin(cx, index);
  }

  deletePin(cx, i) {
    const path = this.path;
    if (this.editing === i) this.editing = null;
    else if (this.editing != null && this.editing > i) this.editing--;
    this.noteDirty = false;
    this.update(cx, (n) => {
      n[path]?.pins?.splice(i, 1);
    });
  }

  windowKey(e, cx) {
    if (this.noteFocus) {
      if (e.keystroke === "escape") {
        this.commitNote(cx);
        this.h.focus();
        cx.stop_propagation();
      }
      return;
    }
    const item = this.current();
    const tool = TOOLS.find((t) => t.keys.includes(keyName(e)));
    if (tool) {
      this.setTool(cx, tool.id);
      cx.stop_propagation();
      return;
    }
    switch (keyName(e)) {
      case "backspace":
        this.deleteStroke(cx, this.strokesOf(item.path).length - 1);
        break;
      case "[":
      case ",":
        this.step_(cx, 1);
        break;
      case "]":
      case ".":
        this.step_(cx, -1);
        break;
      case "enter":
        this.compare = !this.compare;
        cx.notify();
        break;
      case "a":
        this.approve(cx, [item]);
        break;
      case "s":
        this.sendNotes(cx, item);
        break;
      case "x": {
        const g = this.group();
        const i = g.findIndex((x) => x.path === item.path);
        const neighbour = g[i + 1] ?? g[i - 1] ?? null;
        this.remove(cx, item, (cx) => (neighbour ? this.goto(cx, neighbour) : closeOverlay(props().overlay)));
        break;
      }
      case "escape":
        this.commitNote(cx);
        closeOverlay(props().overlay);
        break;
      default:
        return;
    }
    cx.stop_propagation();
  }

  button(t, id, label, onClick, kind) {
    const primary = kind === "primary";
    return div()
      .id(id)
      .px(10).h(26).flex().items_center().flex_none().rounded(6).cursor_pointer()
      .text_size(12)
      .bg(primary ? t.accent : t.raised)
      .text_color(primary ? t.accent_foreground : t.foreground)
      .hover((s) => s.bg(primary ? t.accent : t.hover))
      // Presses on controls must not drag the window.
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => onClick(cx))
      .child(label);
  }

  // The image at its drawn size, with its pins when it's the one being annotated.
  frame(t, item, w, h, annotate, cx) {
    const rel = this.rel.get(item.path)?.rel;
    const dims = rel ? this.dims.get(rel) : null;
    let fw = w;
    let fh = h;
    if (dims) {
      const s = Math.min(w / dims.w, h / dims.h, 2);
      fw = Math.max(1, Math.floor(dims.w * s));
      fh = Math.max(1, Math.floor(dims.h * s));
    }
    if (!rel) {
      return div().w(w).h(h).flex().items_center().justify_center().text_size(12).text_color(t.dim)
        .px(12)
        .child(this.rel.get(item.path)?.error ?? "Loading image…");
    }
    if (annotate) this.framePx = { w: fw, h: fh }; // the stroke SVG is sized from this
    const pins = annotate ? this.pinsOf(item.path) : [];
    const overlay = annotate && this.drawn(item.path).length ? this.strokeSvg.get(item.path)?.rel : null;
    return div()
      .id(`frame-${annotate ? "main" : "old"}`)
      .relative().w(fw).h(fh).flex_none().bg(t.raised)
      .child(image(rel).size_full())
      .when(annotate, (el) =>
        el.on_mouse_down("left", (e, cx) => {
          cx.stop_propagation();
          if (this.tool !== "pin") {
            this.startStroke(cx, item.path, e);
            return;
          }
          const p = this.pointAt(e);
          if (p) this.addPin(cx, p.x, p.y);
        })
          .on_mouse_move((e, cx) => this.extendStroke(cx, e))
          .on_mouse_up("left", (e, cx) => {
            if (!this.live) return;
            cx.stop_propagation();
            this.finishStroke(cx, e);
          }),
      )
      .children(
        pins.map((p, i) =>
          h_flex()
            .id(`pin-${i}`)
            .absolute()
            .left((p.x / 100) * fw - 10)
            .top((p.y / 100) * fh - 10)
            .size(20).items_center().justify_center().rounded(10)
            .bg(t.accent).text_color(t.accent_foreground).text_size(11).font_semibold()
            .border_1().border_color(this.editing === i ? t.foreground : t.accent)
            .cursor_pointer()
            .tooltip(p.text || `pin ${i + 1}`)
            .on_mouse_down("left", (_e, cx) => {
              if (this.tool !== "pin") return; // draw modes: the press reaches the frame and starts a stroke
              cx.stop_propagation();
              this.selectPin(cx, i);
            })
            .on_mouse_down("right", (_e, cx) => {
              cx.stop_propagation();
              this.deletePin(cx, i);
            })
            .child(String(i + 1)),
        ),
      )
      // Drawn strokes, over the pins; the overlay has no mouse handlers, so presses pass through.
      .when(Boolean(overlay), (el) => el.child(div().absolute().inset_0().child(image(overlay).size_full())));
  }

  windowView(t, cx) {
    const item = this.current();
    const g = this.group();
    const idx = g.findIndex((x) => x.path === item.path);
    const older = g[idx + 1] ?? null;
    const status = this.statusOf(item.path);
    const pins = this.pinsOf(item.path);
    const strokes = this.strokesOf(item.path);
    const compare = this.compare && older;

    const pad = PAD;
    const cols = compare ? 2 : 1;
    const labelH = 20;
    const aw = this.area.width > 80 ? this.area.width : 1000;
    const ah = this.area.height > 80 ? this.area.height : 640;
    const availW = Math.max(40, (aw - pad * 2 - (cols - 1) * pad) / cols);
    const availH = Math.max(40, ah - pad * 2 - labelH);

    const pane = (it, annotate, label) =>
      v_flex().flex_none().items_center().gap(4)
        .child(div().h(labelH - 4).text_size(11).text_color(t.dim).truncate().child(label))
        .child(this.frame(t, it, availW, availH, annotate, cx));

    const titleBar = h_flex().h(40).flex_none().items_center().gap(8).px(PAD).bg(t.chrome)
      .child(div().text_size(13).font_semibold().truncate().min_w(0).child(item.name))
      .child(div().text_size(11).text_color(t.dim).flex_none().child(g.length > 1 ? `draft ${g.length - idx} of ${g.length}` : "single draft"))
      .child(this.statusChip(t, status))
      .child(div().flex_1())
      .when(Boolean(older), (el) => el.child(this.button(t, "w-compare", compare ? "Single" : "Compare", (cx) => {
        this.compare = !this.compare;
        cx.notify();
      })))
      .child(this.button(t, "w-approve", "Approve", (cx) => this.approve(cx, [item]), "primary"))
      .child(this.button(t, "w-send", "Send notes", (cx) => this.sendNotes(cx, item)))
      .child(this.button(t, "w-close", "Close", (cx) => {
        this.commitNote(cx);
        closeOverlay(props().overlay);
      }));

    const stage = h_flex().id("w-area").flex_1().min_w(560).min_h(420).items_center().justify_center().gap(pad).bg(t.background)
      .on_size_change((size, cx) => {
        this.area = size;
        cx.notify();
      })
      .when(compare, (el) => el.child(pane(older, false, `previous · ${older.name}`)))
      .child(pane(item, true, compare ? `current · ${item.name}` : this.tool === "pin" ? "click the image to drop a pin" : `drag on the image to draw a ${this.tool}`));

    const armed = this.armed && this.armed.path === item.path && Date.now() - this.armed.at <= CONFIRM_MS;
    const editing = this.editing != null && pins[this.editing] ? this.editing : null;
    const panel = v_flex().w(PANEL_W).flex_none().min_h(0).gap(8).p(PAD).bg(t.chrome)
      .child(div().text_size(12).font_semibold().child(`Pins (${pins.length}) · tool: ${this.tool} [1-4]`))
      .child(
        h_flex().gap(4).flex_none()
          .children(
            TOOLS.map((tl) =>
              div().id(`tool-${tl.id}`).px(8).h(22).flex().items_center().rounded(5).cursor_pointer().text_size(11)
                .bg(this.tool === tl.id ? t.accent : t.raised)
                .text_color(this.tool === tl.id ? t.accent_foreground : t.foreground)
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => this.setTool(cx, tl.id))
                .child(`${tl.keys[0]} ${tl.name}`),
            ),
          ),
      )
      .child(
        v_flex().id("w-pins").flex_1().min_h(0).gap(4).overflow_y_scrollbar()
          .when(!pins.length, (el) => el.child(div().text_size(11).text_color(t.dim).child("Press 1 and click the image to add a pin. Right-click a pin to delete it.")))
          .children(
            pins.map((p, i) =>
              h_flex().id(`row-${i}`).items_center().gap(8).p(6).rounded(6).cursor_pointer()
                .bg(editing === i ? t.selected : t.surface)
                .hover((s) => s.bg(editing === i ? t.selected : t.hover))
                .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                .on_click((_e, cx) => this.selectPin(cx, i))
                .child(h_flex().size(18).flex_none().items_center().justify_center().rounded(9).bg(t.accent).text_color(t.accent_foreground).text_size(10).font_semibold().child(String(i + 1)))
                .child(div().flex_1().min_w(0).text_size(11).text_color(p.text ? t.foreground : t.dim).truncate().child(p.text || "no note")),
            ),
          ),
      )
      .when(strokes.length > 0, (el) =>
        el.child(
          v_flex().id("w-strokes").flex_none().max_h(120).gap(4).overflow_y_scrollbar()
            .child(div().text_size(11).text_color(t.dim).child(`Drawn (${strokes.length}) · Backspace removes the last`))
            .children(
              strokes.map((sk, i) =>
                h_flex().id(`stroke-${i}`).items_center().gap(8).px(6).h(24).flex_none().rounded(6).bg(t.surface)
                  .child(div().w(14).flex_none().text_size(12).text_color(sk.color).child(STROKE_ICON[sk.tool] ?? "✎"))
                  .child(div().flex_1().min_w(0).text_size(11).truncate().child(`${sk.tool} ${i + 1}`))
                  .child(
                    div().id(`stroke-del-${i}`).w(18).h(18).flex().items_center().justify_center().flex_none().rounded(4).cursor_pointer().text_size(11).text_color(t.dim)
                      .hover((st) => st.bg(t.hover))
                      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
                      .on_click((_e, cx) => this.deleteStroke(cx, i))
                      .child("✕"),
                  ),
              ),
            ),
        ),
      )
      .when(editing != null, (el) =>
        el
          .child(div().text_size(11).text_color(t.dim).child(`Note for pin ${editing + 1} · Esc to finish`))
          .child(
            div().w_full().flex_none().p(6).rounded(6).border_1().border_color(t.input).bg(t.background)
              .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
              .child(Textarea.new(this.note).w_full().text_size(12).text_color(t.foreground)),
          ),
      )
      .child(
        div().text_size(10).text_color(armed ? t.blocked : t.dim)
          .child(armed ? "press x again to delete this file" : "1-4 tools · ⌫ undo stroke · [ ] older/newer · ⏎ compare · a approve · s send · x delete · Esc close"),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(10).text_color(t.blocked).child(this.error)));

    return v_flex()
      .id("previews-window")
      .track_focus(this.h)
      .on_key_down((e, cx) => this.windowKey(e, cx))
      // A release outside the image still ends the stroke.
      .on_mouse_up("left", (_e, cx) => this.finishStroke(cx))
      .size_full().bg(t.surface).text_color(t.foreground).text_size(12)
      .child(titleBar)
      .child(h_flex().flex_1().min_h(0).child(stage).child(panel));
  }
}
