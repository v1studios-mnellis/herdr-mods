// Pure helpers for the Hermes kanban board: the status order, payload
// normalization for `hermes kanban list --json --archived` and
// `show <id> --json`, the command lines, and short labels.

export const STATUSES = [
  "triage", "todo", "scheduled", "ready", "running", "blocked", "review", "done", "archived",
];
export const FOLDED_BY_DEFAULT = []; // all columns start unfolded

// One theme color per status; `theme()` names them.
export const TONE = {
  triage: "ansi5",
  todo: "ansi4",
  scheduled: "ansi6",
  ready: "ansi2",
  running: "working",
  blocked: "blocked",
  review: "ansi3",
  done: "done",
  archived: "dim",
};

// What each status can move to, as `[label, command, tone, reason?]`. Every
// move the CLI has is listed here; `reason` asks for the note the CLI wants.
export const MOVES = {
  // The CLI's `promote` accepts todo/blocked → ready; the table offers it from todo only.
  triage: [["Block", "block", "danger", true], ["Schedule", "schedule"]],
  todo: [["Promote", "promote"], ["Block", "block", "danger", true], ["Schedule", "schedule"]],
  scheduled: [["Unblock", "unblock"], ["Block", "block", "danger", true]],
  ready: [["Block", "block", "danger", true], ["Schedule", "schedule"], ["Complete", "complete"]],
  running: [["Complete", "complete"], ["Request review", "request-review"], ["Block", "block", "danger", true]],
  blocked: [["Unblock", "unblock"]],
  review: [
    ["Request changes", "request-changes", "danger", true],
    ["Reopen review", "reopen-review"],
    ["Complete", "complete"],
  ],
  done: [],
  archived: [],
};

export const shortId = (id) => (!id ? "?" : id.startsWith("t_") && id.length > 8 ? id.slice(2, 8) : id.slice(0, 6));

export function duration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
}

// Age of a unix-seconds timestamp.
export const age = (seconds, now = Date.now() / 1000) => (seconds ? duration((now - seconds) * 1000) : "—");

// `hermes` on the paired machine runs through a login shell: herdr-core starts
// programs without one, so the core's PATH can lack ~/.local/bin/hermes.
// `"$@"` keeps every later argument out of shell quoting.
export function hermesArgv(args, board) {
  return [
    "bash",
    ["-lc", 'exec hermes "$@"', "hermes", "kanban", ...(board ? ["--board", board] : []), ...args],
  ];
}

function normalize(raw) {
  return {
    id: String(raw?.id ?? ""),
    title: String(raw?.title ?? ""),
    assignee: raw?.assignee ? String(raw.assignee) : null,
    status: STATUSES.includes(raw?.status) ? raw.status : "todo",
    priority: Number(raw?.priority ?? 0) || 0,
    body: String(raw?.body ?? ""),
    created_at: Number(raw?.created_at ?? 0) || 0,
    started_at: Number(raw?.started_at ?? 0) || null,
    completed_at: Number(raw?.completed_at ?? 0) || null,
  };
}

const rowsOf = (data, what) => {
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.result)) return data.result;
  throw new Error(`unexpected kanban ${what} payload`);
};

export function parseList(stdout) {
  return rowsOf(JSON.parse(stdout), "list").map(normalize);
}

function payloadText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") return payload;
  try {
    return JSON.stringify(payload);
  } catch {
    return String(payload);
  }
}

// `show <id> --json`: { task, latest_summary, parents, children, comments, events }.
export function parseShow(stdout) {
  const data = JSON.parse(stdout);
  const d = data?.task ? data : data?.result?.task ? data.result : null;
  if (!d) throw new Error("unexpected kanban show payload");
  const list = (xs) => (Array.isArray(xs) ? xs : []);
  return {
    task: normalize(d.task),
    summary: typeof d.latest_summary === "string" ? d.latest_summary : null,
    parents: list(d.parents).map(String),
    children: list(d.children).map(String),
    comments: list(d.comments).map((c) => ({
      author: String(c?.author ?? ""),
      body: String(c?.body ?? ""),
      at: Number(c?.created_at ?? 0) || 0,
    })),
    events: list(d.events).map((e) => ({
      kind: String(e?.kind ?? "event"),
      payload: payloadText(e?.payload),
      at: Number(e?.created_at ?? 0) || 0,
    })),
  };
}
