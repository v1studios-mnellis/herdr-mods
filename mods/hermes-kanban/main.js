// Hermes kanban as a pane: one column per status, cards from `hermes kanban`
// on the paired machine. Reading is `list --json --archived` (one fetch per
// TTL window) and `show <id> --json` for a card's body, comments and events.
// Writing goes through the same CLI; archive asks first, in the shipped
// `confirm` dialog, and comes back as a `<mod>.do:<token>` command.

import { View, div } from "gpui-kit";
import { v_flex, h_flex, InputState, Input, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, hc, props, shared, setShared, theme, nextCommand, openOverlay, closeOverlay } from "herdr";
import {
  STATUSES, FOLDED_BY_DEFAULT, TONE, MOVES, age, duration, hermesArgv, parseList, parseShow, shortId,
} from "./lib.js";

const MOD = "hermes-kanban";
// Bumped (shared) after every write, so the other copies refetch at once.
const STAMP = "hermes-kanban.stamp";
// Confirmed actions waiting for `<mod>.do:<token>`, so only one copy runs each.
const PENDING = "hermes-kanban.pending";
const TICK = 10000; // poll and redraw: the board is always a few seconds old
const DETAIL_TTL = 20000; // a card dialog re-reads `show` at most this often
const TIMEOUT = 30000; // the list is ~2 MB on a busy board
const CARD_LIMIT = 100; // per column; the rest is a count
const COL_MIN = 120; // a column is at least this wide, so narrow panes scroll
const COL_MAX = 280;
const COL_GAP = 6;
const COL_PAD = 6;
const PENDING_MS = 10 * 60000;

const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};

// The machine and board come from the layout/overlay props, else shared state,
// so a key binding or another mod can point the same pane at another board.
function config() {
  const p = props() ?? {};
  const d = p.dialog ?? {};
  return {
    // Local default: this host's paired djed machine is named "anton-2" (2026-11-11);
    // props().machine / shared("hermes-kanban.machine") still override it.
    machine: d.machine ?? p.machine ?? shared("hermes-kanban.machine") ?? "anton-2",
    board: d.board ?? p.board ?? shared("hermes-kanban.board") ?? null,
  };
}

const message = (e) => String(e?.message ?? e);
const lastLine = (text) => (text ?? "").trim().split("\n").filter(Boolean).pop() ?? "";

export default class HermesKanban extends View {
  init(_props, cx) {
    this.handle = cx.focus_handle();
    this.cfg = config();
    this.busy = false;
    this.error = null;
    this.notice = null;

    const dialog = props()?.dialog;
    if (dialog) {
      this.dialogProps = dialog;
      this.tasks = [];
      this.detail = null;
      this.detailError = null;
      this.stamp = shared(STAMP) ?? 0;
      if (dialog.mode !== "detail") this.buildForm();
      if (dialog.mode === "detail") {
        this.commentIn = TextareaState.new({ placeholder: "Comment on this card", rows: 3 });
        this.loadDetail(cx, dialog.id);
        this.handle.focus();
        cx.timer.every(5000, (cx) => {
          const stamp = shared(STAMP) ?? 0;
          if (stamp !== this.stamp || Date.now() - (this.detailAt ?? 0) >= DETAIL_TTL) {
            this.stamp = stamp;
            this.loadDetail(cx, this.dialogProps.id);
          }
          cx.notify();
        });
      }
      return;
    }

    // "folded-v2": the v1 key held the old default ["done","archived"]; a fresh
    // key makes existing copies start unfolded with the new default.
    const folded = props()?.folded ?? store.get("folded-v2", FOLDED_BY_DEFAULT);
    this.folded = new Set(Array.isArray(folded) ? folded : FOLDED_BY_DEFAULT);
    this.tasks = [];
    this.loaded = 0;
    this.loading = false;
    this.offline = null;
    this.machineNote = null;
    this.stamp = shared(STAMP) ?? 0;
    this.restore();
    this.load(cx, true);
    this.checkMachine(cx);
    cx.timer.every(TICK, (cx) => {
      const stamp = shared(STAMP) ?? 0;
      if (stamp !== this.stamp) {
        this.stamp = stamp;
        this.load(cx, true);
      } else if (Date.now() - this.loaded >= TICK) this.load(cx);
      cx.notify();
    });
    cx.timer.every(60000, (cx) => this.checkMachine(cx));
    cx.spawn(async (cx) => {
      for (;;) {
        try {
          const command = await nextCommand();
          this.command(command, cx);
        } catch {}
        cx.notify();
      }
    });
  }

  // ---- data ---------------------------------------------------------------

  // The last snapshot, so a new copy or a reload shows the board at once.
  restore() {
    const cache = store.get(`cache:${this.cfg.machine}:${this.cfg.board ?? ""}`, null);
    if (!cache) return;
    this.tasks = Array.isArray(cache.tasks) ? cache.tasks : [];
    this.loaded = cache.at ?? 0;
  }

  load(cx, force) {
    if (this.loading) return;
    if (!force && Date.now() - this.loaded < TICK) return;
    this.loading = true;
    const { machine, board } = this.cfg;
    cx.spawn(async (cx) => {
      try {
        const [cmd, args] = hermesArgv(["list", "--json", "--archived"], board);
        const r = await exec(cmd, args, { on: machine, timeout: TIMEOUT });
        if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `exit ${r.code}`);
        this.tasks = parseList(r.stdout);
        this.loaded = Date.now();
        this.offline = null;
        this.machineNote = null; // live data proves the machine is reachable
        this.notice = null; // notices fade at the next tick; write errors stay until the next write
        // Bodies are long; the tooltip shows 600 characters and the dialog reads `show`.
        store.set(`cache:${machine}:${board ?? ""}`, {
          at: this.loaded,
          tasks: this.tasks.map((t) => ({ ...t, body: t.body.slice(0, 600) })),
        });
      } catch (e) {
        this.offline = message(e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // A missing or offline machine is worth saying before the first failed fetch.
  checkMachine(cx) {
    const name = this.cfg.machine;
    cx.spawn(async (cx) => {
      try {
        const r = await hc(["machine", "ls", "--json"]);
        if (r.code !== 0) {
          this.machineNote = `hc machine ls failed (exit ${r.code}).`;
        } else {
          const machines = JSON.parse(r.stdout).machines ?? [];
          const machine = machines.find((m) => m.name === name);
          this.machineNote = !machine
            ? `No machine "${name}" in hc machine ls.`
            : machine.state !== "connected"
              ? `Machine "${name}" is ${machine.state}.`
              : null;
        }
      } catch {
        this.machineNote = "hc machine ls returned unreadable output.";
      }
      cx.notify();
    });
  }

  loadDetail(cx, id) {
    if (!id || this.detailLoading) return;
    this.detailLoading = true;
    const { machine, board } = this.cfg;
    cx.spawn(async (cx) => {
      try {
        const [cmd, args] = hermesArgv(["show", id, "--json"], board);
        const r = await exec(cmd, args, { on: machine, timeout: TIMEOUT });
        if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `exit ${r.code}`);
        this.detail = parseShow(r.stdout);
        this.detailAt = Date.now();
        this.detailError = null;
      } catch (e) {
        this.detailError = message(e);
      } finally {
        this.detailLoading = false;
        cx.notify();
      }
    });
  }

  // ---- writing ------------------------------------------------------------

  // `args` is a full `hermes kanban` argument list; the login shell keeps every
  // later argument out of quoting.
  act(cx, args, opts = {}) {
    if (this.busy) return;
    this.busy = true;
    this.error = null;
    this.notice = null;
    const { machine, board } = this.cfg;
    const summary = `${args[0]}${args[1]?.startsWith("t_") ? ` ${shortId(args[1])}` : ""}`;
    cx.spawn(async (cx) => {
      try {
        const [cmd, argv] = hermesArgv(args, board);
        const r = await exec(cmd, argv, { on: machine, timeout: TIMEOUT });
        if (r.code !== 0) throw new Error(lastLine(r.stderr || r.stdout) || `exit ${r.code}`);
        this.notice = `${summary} done`;
        this.loaded = 0;
        setShared(STAMP, Date.now());
        if (opts.detail) this.loadDetail(cx, this.dialogProps?.id);
        if (opts.close) closeOverlay(props().overlay);
      } catch (e) {
        this.error = message(e);
      } finally {
        this.busy = false;
        cx.notify();
      }
    });
    cx.notify();
  }

  // Keys and confirmed actions arrive as `<mod>.<command>`.
  command(command, cx) {
    if (command === "focus") {
      this.handle.focus();
    } else if (command === "refresh") {
      this.load(cx, true);
    } else if (command === "new") {
      this.openDialog({ mode: "create" });
    } else if (command.startsWith("toggle:")) {
      this.toggle(command.slice(7), cx);
    } else if (command.startsWith("do:")) {
      const token = command.slice(3);
      const all = { ...(shared(PENDING) ?? {}) };
      const record = all[token];
      if (!record) return;
      delete all[token];
      setShared(PENDING, all);
      if (record.close) closeOverlay(record.close);
      this.act(cx, record.args);
    }
  }

  toggle(status, cx) {
    if (this.folded.has(status)) this.folded.delete(status);
    else this.folded.add(status);
    store.set("folded-v2", [...this.folded]);
    cx.notify();
  }

  // Archive is the delete-equivalent: the shipped confirm dialog asks first, then
  // runs `<mod>.do:<token>` here with the action recorded in shared state.
  confirmArchive(task, close) {
    const token = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const now = Date.now();
    const pending = Object.fromEntries(Object.entries(shared(PENDING) ?? {}).filter(([, r]) => now - (r.at ?? 0) < PENDING_MS));
    pending[token] = { at: now, args: ["archive", task.id], close };
    setShared(PENDING, pending);
    openOverlay({
      mod: "confirm",
      kind: "dialog",
      modal: true,
      width: 460,
      height: 210,
      props: {
        title: "Archive card?",
        detail: `${task.id} — ${task.title}\n\nArchive takes it off the board. It stays in the archive; this is the CLI's delete-equivalent.`,
        command: { name: `${MOD}.do:${token}` },
      },
    });
  }

  openDialog(dialog) {
    const detail = dialog.mode === "detail";
    const form = dialog.mode === "create" || dialog.mode === "edit";
    openOverlay({
      mod: MOD,
      kind: "dialog",
      width: detail ? 0.62 : 560,
      height: detail ? 0.84 : form ? 540 : 250,
      props: { dialog: { ...dialog, machine: this.cfg.machine, board: this.cfg.board } },
    });
  }

  // ---- dialogs ------------------------------------------------------------

  buildForm() {
    const dialog = this.dialogProps;
    const task = dialog.task ?? null;
    if (dialog.mode === "create" || dialog.mode === "edit") {
      this.titleIn = InputState.new({ value: task?.title ?? "", placeholder: "Title" });
      this.bodyIn = TextareaState.new({ value: task?.body ?? "", placeholder: "Body", rows: 9 });
      this.assigneeIn = InputState.new({ value: task?.assignee ?? "", placeholder: "Assignee profile" });
      this.priorityIn = InputState.new({ value: task?.priority ? String(task.priority) : "", placeholder: "Priority" });
      this.titleIn.on("submit", (_e, cx) => this.submitForm(cx));
      this.titleIn.focus();
    } else if (dialog.mode === "comment") {
      this.bodyIn = TextareaState.new({ placeholder: "Comment", rows: 6 });
      this.bodyIn.focus();
    } else {
      this.valueIn = InputState.new({ value: dialog.value ?? "", placeholder: dialog.label ?? "" });
      this.valueIn.on("submit", (_e, cx) => this.submitForm(cx));
      this.valueIn.focus();
    }
  }

  submitForm(cx) {
    const dialog = this.dialogProps;
    if (dialog.mode === "create") {
      const title = this.titleIn.value().trim();
      if (!title) return this.fail("A title is needed.", cx);
      const body = this.bodyIn.value().trim();
      const assignee = this.assigneeIn.value().trim();
      const priority = this.priorityIn.value().trim();
      this.act(
        cx,
        [
          "create", title,
          ...(body ? ["--body", body] : []),
          ...(assignee ? ["--assignee", assignee] : []),
          ...(priority ? ["--priority", priority] : []),
        ],
        { close: true },
      );
      return;
    }
    if (dialog.mode === "edit") {
      const args = ["edit", dialog.id];
      const title = this.titleIn.value().trim();
      if (title) args.push("--title", title);
      const body = this.bodyIn.value().trim();
      if (body) args.push("--body", body);
      const priority = this.priorityIn.value().trim();
      if (priority) args.push("--priority", priority);
      if (args.length === 2) return this.fail("Nothing to change.", cx);
      this.act(cx, args, { close: true, detail: true });
      return;
    }
    if (dialog.mode === "comment") {
      const text = this.bodyIn.value().trim();
      if (!text) return this.fail("Nothing to comment.", cx);
      this.act(cx, ["comment", dialog.id, text], { close: true, detail: true });
      return;
    }
    const text = this.valueIn.value().trim();
    if (!text && !dialog.allowEmpty) return this.fail("Some text is needed.", cx);
    this.act(cx, [...(dialog.args ?? []), ...(text ? [text] : [])], { close: true, detail: true });
  }

  fail(text, cx) {
    this.error = text;
    cx.notify();
  }

  button(t, id, label, tone, enabled, onClick) {
    const primary = tone === "primary";
    return div()
      .id(id)
      .h(24)
      .px(9)
      .flex_none()
      .flex()
      .items_center()
      .rounded(6)
      .text_size(11.5)
      .bg(primary ? t.solid : t.raised)
      .text_color(!enabled ? t.dim : primary ? t.solid_foreground : tone === "danger" ? t.blocked : t.foreground)
      .when(enabled, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click((_e, cx) => onClick(cx)))
      .child(label);
  }

  field(t, state, height) {
    return h_flex()
      .flex_none()
      .h(height ?? 30)
      .px(8)
      .rounded(7)
      .border_1()
      .border_color(t.input)
      .bg(t.background)
      .items_center()
      .child(Input.new(state).w_full().text_size(12.5).text_color(t.foreground));
  }

  section(t, label) {
    return div().pt(4).text_size(11).font_semibold().text_color(t.dim).child(label);
  }

  formView(t, cx) {
    const dialog = this.dialogProps;
    const heading =
      dialog.mode === "create" ? "New card"
        : dialog.mode === "edit" ? `Edit ${shortId(dialog.id)}`
          : dialog.mode === "comment" ? `Comment on ${shortId(dialog.id)}`
            : dialog.title ?? "Enter text";
    const label = (text) => div().pt(8).pb(4).text_size(11).text_color(t.dim).child(text);
    return v_flex()
      .id("kb-form")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(16)
      .gap(4)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(
        h_flex().flex_none().items_center().gap(8)
          .child(div().flex_1().text_size(15).font_semibold().child(heading))
          .child(div().text_size(11).text_color(t.dim).child("Esc")),
      )
      .when(dialog.mode === "create" || dialog.mode === "edit", (el) =>
        el
          .child(label("Title"))
          .child(this.field(t, this.titleIn))
          .child(label("Body"))
          .child(div().flex_none().p(6).rounded(7).border_1().border_color(t.input).bg(t.background)
            .child(Textarea.new(this.bodyIn).w_full().text_size(12.5).text_color(t.foreground)))
          .child(label("Assignee and priority (optional)"))
          .child(h_flex().flex_none().gap(8)
            .child(h_flex().flex_1().child(this.field(t, this.assigneeIn)))
            .child(h_flex().w(110).flex_none().child(this.field(t, this.priorityIn)))))
      .when(dialog.mode === "comment", (el) =>
        el.child(div().pt(6).flex_1().min_h(0).p(6).rounded(7).border_1().border_color(t.input).bg(t.background)
          .child(Textarea.new(this.bodyIn).w_full().text_size(12.5).text_color(t.foreground))))
      .when(dialog.mode !== "create" && dialog.mode !== "edit" && dialog.mode !== "comment", (el) =>
        el
          .child(label(dialog.label ?? "Text"))
          .child(this.field(t, this.valueIn))
          .when(Boolean(dialog.hint), (el) => el.child(div().pt(4).text_size(11).text_color(t.dim).child(dialog.hint))))
      .child(div().flex_1())
      .when(Boolean(this.error), (el) => el.child(div().pb(4).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(
        h_flex().flex_none().gap(8).justify_end()
          .child(this.button(t, "kb-cancel", "Cancel", null, !this.busy, () => closeOverlay(props().overlay)))
          .child(this.button(t, "kb-save", dialog.mode === "edit" ? "Save" : dialog.mode === "comment" ? "Comment" : "Create", "primary", !this.busy,
            (cx) => this.submitForm(cx))),
      );
  }

  detailView(t, cx) {
    const dialog = this.dialogProps;
    const detail = this.detail;
    const task = detail?.task ?? dialog.task;
    if (!task && !this.detailError) {
      return v_flex().size_full().p(18).gap(8).bg(t.popover).text_color(t.dim).child("Loading…");
    }
    const status = task?.status ?? "todo";
    const tone = t[TONE[status]] ?? t.muted;
    const comments = detail?.comments ?? [];
    const events = detail?.events ?? [];
    const moves = MOVES[status] ?? [];
    const markdown = (id, text) => TextView.markdown(id, text).w_full().selectable();

    return v_flex()
      .id("kb-detail")
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key !== "escape") return;
        closeOverlay(props().overlay);
        cx.stop_propagation();
      })
      .size_full()
      .min_h(0)
      .p(16)
      .gap(8)
      .bg(t.popover)
      .text_size(13)
      .text_color(t.foreground)
      .child(
        h_flex().flex_none().gap(8).items_center()
          .child(div().text_size(11).text_color(t.dim).child(task?.id ?? dialog.id))
          .child(div().px(6).h(18).flex().items_center().rounded(4).bg(tone + "22").text_color(tone).text_size(10.5).child(status))
          .child(div().text_size(11).text_color(t.muted).child(task?.assignee ? `→ ${task.assignee}` : "unassigned"))
          .child(div().text_size(11).text_color(t.dim).child(`created ${age(task?.created_at ?? 0)} ago`))
          .child(div().flex_1())
          .child(div().id("kb-detail-close").w(22).h(22).flex().items_center().justify_center().rounded(6).text_size(14)
            .text_color(t.dim).cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
            .on_click(() => closeOverlay(props().overlay)).child("×")),
      )
      .child(
        v_flex().id("kb-detail-body").flex_1().min_h(0).gap(8).overflow_y_scrollbar()
          .child(div().text_size(14.5).font_semibold().child(task?.title ?? ""))
          .when(Boolean(detail?.summary), (el) =>
            el.child(this.section(t, "Latest summary")).child(markdown("kb-md-summary", detail.summary)))
          .child(this.section(t, "Body"))
          .when(task?.body, (el) => el.child(markdown("kb-md-body", task.body)))
          .when(!task?.body, (el) => el.child(div().text_color(t.dim).child("No body.")))
          .child(this.section(t, `Comments (${comments.length})`))
          .when(!comments.length, (el) => el.child(div().text_color(t.dim).child("No comments.")))
          .children(
            comments.slice(-20).map((c, i) =>
              v_flex().id(`kb-comment-${i}`).flex_none().gap(2).pl(8).border_l(2).border_color(t.border)
                .child(div().text_size(10.5).text_color(t.dim).child(`${c.author || "?"} · ${age(c.at)} ago`))
                .child(markdown(`kb-md-c-${i}`, c.body))),
          )
          .child(this.section(t, `Events (${events.length})`))
          .children(
            events.slice(-20).reverse().map((e, i) =>
              h_flex().id(`kb-event-${i}`).flex_none().gap(6).text_size(10.5)
                .child(div().w(64).flex_none().text_color(t.muted).child(e.kind))
                .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(e.payload.slice(0, 160)))
                .child(div().flex_none().text_color(t.dim).child(age(e.at)))),
          ),
      )
      .when(Boolean(this.detailError), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.detailError)))
      .child(
        h_flex().flex_none().gap(6).pt(6).items_center().border_t(1).border_color(t.border)
          .child(div().flex_1().min_w(0).p(6).rounded(7).border_1().border_color(t.input).bg(t.background)
            .child(Textarea.new(this.commentIn).w_full().text_size(12).text_color(t.foreground)))
          .child(this.button(t, "kb-send-comment", "Comment", "primary", !this.busy, (cx) => {
            const text = this.commentIn.value().trim();
            if (text) this.act(cx, ["comment", dialog.id, text], { detail: true });
            else this.fail("Nothing to comment.", cx);
          })),
      )
      .child(
        h_flex().flex_none().gap(6).items_center().flex_wrap()
          .child(this.button(t, "kb-edit", "Edit", null, !this.busy, () =>
            this.openDialog({
              mode: "edit",
              id: task.id,
              task: { title: task.title, body: task.body, assignee: task.assignee, priority: task.priority },
            })))
          .child(this.button(t, "kb-assign", "Assign", null, !this.busy, () =>
            this.openDialog({
              mode: "text",
              title: "Assign card",
              label: "Profile",
              value: task.assignee ?? "",
              hint: "Type “none” to unassign.",
              args: ["assign", task.id],
              id: task.id,
            })))
          .children(
            moves.map(([label, command, tone2, reason], i) =>
              this.button(t, `kb-move-${i}`, label, tone2 === "danger" ? "danger" : null, !this.busy, (cx) => {
                if (reason)
                  this.openDialog({
                    mode: "text",
                    title: label,
                    label: command === "block" ? "Reason (optional)" : "Reason",
                    allowEmpty: command === "block",
                    hint: command === "block" ? "Also stored as a comment." : "The worker needs this to act.",
                    args: [command, task.id],
                    id: task.id,
                  });
                else this.act(cx, [command, task.id], { detail: true });
              })))
          .child(div().flex_1())
          .child(this.button(t, "kb-archive", "Archive", "danger", !this.busy && status !== "archived", () =>
            this.confirmArchive(task, props().overlay))),
      )
      .when(Boolean(this.error), (el) => el.child(div().text_size(11.5).text_color(t.blocked).child(this.error)));
  }

  // ---- board --------------------------------------------------------------

  render(cx) {
    const t = theme();
    const dialog = props()?.dialog;
    if (dialog) return dialog.mode === "detail" ? this.detailView(t, cx) : this.formView(t, cx);
    return this.board(t, cx);
  }

  board(t, cx) {
    const now = Date.now() / 1000;
    const by = new Map(STATUSES.map((s) => [s, []]));
    for (const task of this.tasks) (by.get(task.status) ?? by.get("todo")).push(task);
    const problem = this.offline ?? this.machineNote;
    const foldedCounts = STATUSES.filter((s) => this.folded.has(s) && (by.get(s)?.length ?? 0) > 0)
      .map((s) => `${by.get(s).length} ${s}`).join(", ");
    const countText = `· ${this.tasks.length} ${this.tasks.length === 1 ? "card" : "cards"}${foldedCounts ? ` (${foldedCounts} folded)` : ""}`;

    return v_flex()
      .id("kb-root")
      .size_full()
      .min_h(0)
      .track_focus(this.handle)
      .bg(t.background)
      .text_size(13)
      .text_color(t.foreground)
      .on_size_change((size, cx) => {
        if (this.size && Math.abs(this.size.width - size.width) < 1) {
          this.size = size;
          return;
        }
        this.size = size;
        cx.notify();
      })
      .child(
        h_flex().flex_none().h(32).px(10).gap(8).items_center().bg(t.chrome).border_b(1).border_color(t.border)
          .child(div().text_size(12.5).font_semibold().child("Hermes Kanban"))
          .child(div().text_size(11).text_color(t.dim).child(this.cfg.board ? `board ${this.cfg.board}` : "board default"))
          .child(div().text_size(11).text_color(t.dim).child(`· ${this.cfg.machine}`))
          .when(this.tasks.length > 0, (el) => el.child(div().text_size(11).text_color(t.dim).child(countText)))
          .child(div().flex_1())
          .when(Boolean(problem), (el) =>
            el.child(div().px(6).h(19).flex().items_center().rounded(5).bg(t.blocked + "22").text_color(t.blocked).text_size(10.5).child("offline")))
          .child(
            div().id("kb-refresh").px(6).h(21).flex().items_center().rounded(6).text_size(11).text_color(t.muted)
              .cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground))
              .on_click((_e, cx) => this.load(cx, true)).child(this.loading ? "loading…" : "refresh"),
          )
          .child(
            div().id("kb-new").px(8).h(21).flex().items_center().rounded(6).text_size(11).font_medium()
              .bg(t.solid).text_color(t.solid_foreground).cursor_pointer().hover((s) => s.opacity(0.88))
              .on_click(() => this.openDialog({ mode: "create" })).child("+ New"),
          ),
      )
      .when(Boolean(problem), (el) =>
        el.child(
          h_flex().flex_none().px(10).py(5).gap(6).items_center().bg(t.blocked + "14").border_b(1).border_color(t.border)
            .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.blocked)
              .child(`Can't reach ${this.cfg.machine}: ${problem} — retrying every ${duration(TICK)}.`)),
        ))
      .when(Boolean(this.error), (el) =>
        el.child(div().flex_none().px(10).py(4).text_size(11).text_color(t.blocked).border_b(1).border_color(t.border).child(this.error)))
      .when(Boolean(this.notice), (el) =>
        el.child(div().flex_none().px(10).py(4).text_size(11).text_color(t.done).border_b(1).border_color(t.border).child(this.notice)))
      .child(
        h_flex().id("kb-columns").flex_1().min_h(0).p(COL_PAD).gap(COL_GAP).overflow_x_scrollbar()
          .children(STATUSES.map((status) => this.column(t, cx, status, by.get(status), now))),
      );
  }

  // Nine columns share the pane when they can and scroll sideways when it is too
  // narrow; each is 120..280 px wide.
  columnWidth() {
    const fit = (this.size?.width ?? 0) - COL_PAD * 2 - COL_GAP * (STATUSES.length - 1);
    if (fit <= 0) return 160;
    return Math.max(COL_MIN, Math.min(COL_MAX, Math.floor(fit / STATUSES.length)));
  }

  column(t, cx, status, tasks, now) {
    const tone = t[TONE[status]] ?? t.muted;
    const folded = this.folded.has(status);
    return v_flex()
      .id(`kb-col-${status}`)
      .w(this.columnWidth())
      .flex_none()
      .h_full()
      .min_h(0)
      .rounded(8)
      .overflow_hidden()
      .bg(t.chrome)
      .border_1()
      .border_color(t.border)
      .child(
        h_flex().id(`kb-col-h-${status}`).flex_none().h(30).px(8).gap(6).items_center().border_b(1).border_color(t.border)
          .cursor_pointer().hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.toggle(status, cx))
          .child(div().w(6).h(6).flex_none().rounded(3).bg(tone))
          .child(div().text_size(11.5).font_semibold().text_color(tone).child(status))
          .child(div().text_size(10.5).text_color(t.dim).child(String(tasks.length)))
          .child(div().flex_1())
          .child(div().text_size(10).text_color(t.dim).child(folded ? "▸" : "▾")),
      )
      .when(!folded, (el) =>
        el.child(
          v_flex().id(`kb-col-list-${status}`).flex_1().min_h(0).p(4).gap(4).overflow_y_scrollbar()
            .children(tasks.slice(0, CARD_LIMIT).map((task) => this.card(t, cx, task, now)))
            .when(tasks.length > CARD_LIMIT, (el) =>
              el.child(div().p(4).text_size(10.5).text_color(t.dim).child(`+${tasks.length - CARD_LIMIT} more`)))
            .when(tasks.length === 0, (el) => el.child(div().p(4).text_size(10.5).text_color(t.dim).child("nothing here"))),
        ));
  }

  card(t, cx, task, now) {
    const tone = t[TONE[task.status]] ?? t.muted;
    return v_flex()
      .id(`kb-card-${task.id}`)
      .flex_none()
      .p(6)
      .gap(3)
      .rounded(6)
      .bg(t.surface)
      .border_1()
      .border_color(t.border)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover).border_color(t.input))
      .tooltip(`${task.title}\n${task.id}${task.body ? `\n\n${task.body.slice(0, 600)}` : ""}`)
      .on_click(() =>
        this.openDialog({ mode: "detail", id: task.id, task: { ...task } }))
      .child(
        h_flex().items_center().gap(5)
          .child(div().text_size(10).text_color(t.dim).child(shortId(task.id)))
          .when(task.priority > 0, (el) =>
            el.child(div().px(3).rounded(3).bg(t.raised).text_size(9.5).text_color(tone).child(`p${task.priority}`)))
          .child(div().flex_1())
          .child(div().text_size(10).text_color(t.dim).child(age(task.created_at, now))),
      )
      .child(div().text_size(11.5).text_color(t.foreground).truncate().child(task.title))
      .child(
        h_flex().items_center().gap(4).text_size(10.5)
          .when(Boolean(task.assignee), (el) => el.child(div().min_w(0).truncate().text_color(t.muted).child(task.assignee)))
          .when(!task.assignee, (el) => el.child(div().text_color(t.dim).child("unassigned"))),
      );
  }
}
