// Helpers for the previews mod: finding the images an agent saved, grouping
// drafts, copying them under the app's folder so image() can show them, the
// notes.json sidecar (local or on a remote machine) and the hc send-back.

import { exec, hc, readTextFile, writeTextFile, appHome } from "herdr";
import * as fs from "fs/promises";

export const DIR = ".herdr-previews";
export const NOTES = "notes.json";
export const IMAGE_LIMIT = 40; // newest images listed and copied
export const CACHE = "mods/previews/.cache"; // relative to appHome(); hidden, so no reloads

const on = (machine) => (machine ? { on: machine } : {});
const join = (folder, ...rest) => [folder.replace(/\/+$/, ""), ...rest].join("/");
export const dirOf = (folder) => join(folder, DIR);
export const baseName = (path) => path.slice(path.lastIndexOf("/") + 1);

// ---- grouping -----------------------------------------------------------

// "homepage-v3.png" -> "homepage". Strips the extension, then trailing ISO
// dates/times, unix timestamps and -vN / -N counters until nothing changes.
export function stemOf(name) {
  let s = baseName(name).replace(/\.[A-Za-z0-9]+$/, "");
  const rules = [
    /[-_ ]?\d{4}-?\d{2}-?\d{2}(?:[T_ -]?\d{2}[:-]?\d{2}(?:[:-]?\d{2})?Z?)?$/,
    /[-_ ]\d{10}(?:\d{3})?$/,
    /[-_ ]v?\d+$/i,
  ];
  for (let again = true; again; ) {
    again = false;
    for (const rule of rules) {
      const next = s.replace(rule, "");
      if (next === "") return s; // the whole name is a date or a number: keep it
      if (next !== s) {
        s = next;
        again = true;
      }
    }
  }
  return s;
}

// Newest first, and groups ordered by their newest draft.
export function groupItems(items) {
  const by = new Map();
  for (const item of items) {
    if (!by.has(item.stem)) by.set(item.stem, []);
    by.get(item.stem).push(item);
  }
  const groups = [...by.entries()].map(([stem, list]) => ({
    stem,
    items: list.sort((a, b) => b.mtime - a.mtime),
  }));
  return groups.sort((a, b) => b.items[0].mtime - a.items[0].mtime);
}

// ---- discovery ------------------------------------------------------------

// The images in <folder>/.herdr-previews, newest first. A missing folder is
// an empty list; an unreachable machine rejects.
export async function listImages(folder, machine) {
  const dir = dirOf(folder);
  const r = await exec(
    "find",
    [dir, "-maxdepth", "1", "-type", "f", "(", "-name", "*.png", "-o", "-name", "*.webp", "-o", "-name", "*.jpg", "-o", "-name", "*.jpeg", ")", "-printf", "%T@\t%p\n"],
    on(machine),
  );
  const items = [];
  for (const line of r.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const mtime = parseFloat(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (!path || Number.isNaN(mtime)) continue;
    items.push({ path, name: baseName(path), stem: stemOf(path), mtime });
  }
  items.sort((a, b) => b.mtime - a.mtime);
  return items.slice(0, IMAGE_LIMIT);
}

// ---- image cache --------------------------------------------------------------

export function hashOf(s) {
  let a = 0x811c9dc5;
  let b = 0x9747b28c;
  for (let i = 0; i < s.length; i++) {
    a = Math.imul(a ^ s.charCodeAt(i), 0x01000193) >>> 0;
    b = Math.imul(b ^ s.charCodeAt(i), 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

// image() only reads below appHome(), so every shown image is copied to
// mods/previews/.cache/<hash>-<mtime ms>.<ext> (a new mtime is a new name, so a
// redrawn draft is never served from an old decode). Resolves with the path
// relative to appHome(), or null when the copy isn't ready yet.
export async function cachedImage(item, machine) {
  const ext = (item.path.match(/\.(png|webp|jpe?g)$/i)?.[1] ?? "png").toLowerCase();
  const id = hashOf(`${machine ?? ""}:${item.path}`);
  const file = `${id}-${Math.round(item.mtime * 1000)}.${ext}`;
  const rel = `${CACHE}/${file}`;
  const dir = `${appHome()}/${CACHE}`;
  const dest = `${dir}/${file}`;
  // The sandbox fs has no stat, so list the dir once for the exists check and the cleanup.
  let cached = [];
  try {
    cached = await fs.readdir(dir);
  } catch {} // no cache dir yet
  if (cached.includes(file)) return rel;
  if (!machine && Date.now() / 1000 - item.mtime < 1.5) return null; // still being written
  await fs.mkdir(dir, { recursive: true });
  if (machine) {
    const r = await exec(
      "sh",
      ["-c", 'ssh "$1" base64 -- "$2" > "$3.b64" && base64 -d "$3.b64" > "$3.tmp" && mv "$3.tmp" "$3"; s=$?; rm -f "$3.b64" "$3.tmp"; exit $s', "sh", machine, item.path, dest],
      { timeout: 120000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || `copy from ${machine} failed`);
  } else {
    // The mod sandbox's fs/promises has only mkdir/readdir/unlink/readFile/writeFile
    // (no stat/copyFile/rename/cp), so don't reintroduce those.
    const bytes = await fs.readFile(item.path);
    await fs.writeFile(dest, bytes);
  }
  try {
    for (const old of cached) {
      if (old.startsWith(`${id}-`) && old !== file) await fs.unlink(`${dir}/${old}`);
    }
  } catch {}
  return rel;
}

export async function removeCached(rel) {
  try {
    await fs.unlink(`${appHome()}/${rel}`);
  } catch {}
}

// ---- stroke overlay ---------------------------------------------------------
// Free-draw strokes are stored as percentages of the image and drawn by one SVG
// per image (viewBox 0 0 100 100, stretched to the frame). The file lives in the
// hidden cache dir (a write there never reloads the mod) under a versioned name,
// strokes-<hash>-<n>.svg: svg() may cache by path, so every save is a new path
// and the previous version is removed.

export const STROKE_PX = 2; // drawn line width on screen, whatever the frame size
export const FRAME_PX = { w: 800, h: 600 }; // assumed until the frame has been rendered
const num = (n) => Math.round(Math.min(100, Math.max(0, Number(n) || 0)) * 100) / 100;
const px = (n) => Math.round(n * 100) / 100;
const hexOf = (c) => (/^#[0-9a-f]{3,8}$/i.test(c ?? "") ? c : "#ff4d4d");

// The SVG's viewBox is the frame's pixel size (stretched to the frame, so 1 unit
// is 1 px on both axes) and the percent coordinates are scaled into it. That way
// STROKE_PX is the same on screen for every frame size and on both axes, with no
// reliance on vector-effect (which the renderer may ignore).
export function strokesSvg(strokes, framePx) {
  const w = Math.max(1, framePx?.w || FRAME_PX.w);
  const h = Math.max(1, framePx?.h || FRAME_PX.h);
  const X = (n) => px((num(n) / 100) * w);
  const Y = (n) => px((num(n) / 100) * h);
  const attrs = (c) => `fill="none" stroke="${hexOf(c)}" stroke-width="${STROKE_PX}" stroke-linecap="round" stroke-linejoin="round" vector-effect="non-scaling-stroke"`;
  const shapes = [];
  for (const s of strokes) {
    if (s.tool === "pen" && Array.isArray(s.pts) && s.pts.length) {
      // A single point (a click) is a zero-length segment; round caps make it a dot.
      const pts = s.pts.length === 1 ? [s.pts[0], s.pts[0]] : s.pts;
      shapes.push(`<polyline points="${pts.map((p) => `${X(p.x)},${Y(p.y)}`).join(" ")}" ${attrs(s.color)}/>`);
    } else if (s.tool === "line" && s.a && s.b) {
      shapes.push(`<line x1="${X(s.a.x)}" y1="${Y(s.a.y)}" x2="${X(s.b.x)}" y2="${Y(s.b.y)}" ${attrs(s.color)}/>`);
    } else if (s.tool === "circle" && s.c) {
      shapes.push(`<ellipse cx="${X(s.c.x)}" cy="${Y(s.c.y)}" rx="${px((num(s.rx) / 100) * w)}" ry="${px((num(s.ry) / 100) * h)}" ${attrs(s.color)}/>`);
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">${shapes.join("")}</svg>\n`;
}

// image id -> { n, rel }: the version last written, so a save needs no readdir.
const strokeFiles = new Map();

// Writes the next version of an image's stroke SVG and removes the previous one.
// Resolves with the path relative to appHome(), or null when there is nothing to
// draw (then the file is removed). `machine`+`path` name the image.
export async function writeStrokeSvg(machine, path, strokes, framePx) {
  const id = hashOf(`${machine ?? ""}:${path}`);
  const dir = `${appHome()}/${CACHE}`;
  let prev = strokeFiles.get(id);
  let stale = [];
  if (!prev) {
    // First save of this image in this run: clear versions an earlier run left behind.
    const re = new RegExp(`^strokes-${id}-(\\d+)\\.svg$`);
    let files = [];
    try {
      files = await fs.readdir(dir);
    } catch {} // no cache dir yet
    stale = files.filter((f) => re.test(f));
    prev = { n: Math.max(0, ...stale.map((f) => Number(re.exec(f)[1]))), rel: null };
  }
  let rel = null;
  if (strokes.length) {
    const n = prev.n + 1;
    const file = `strokes-${id}-${n}.svg`;
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${dir}/${file}`, strokesSvg(strokes, framePx));
    rel = `${CACHE}/${file}`;
    strokeFiles.set(id, { n, rel });
  } else {
    strokeFiles.set(id, { n: prev.n, rel: null });
  }
  const drop = [...stale.map((f) => `${CACHE}/${f}`), ...(prev.rel ? [prev.rel] : [])];
  for (const r of drop) {
    if (r === rel) continue;
    try {
      await fs.unlink(`${appHome()}/${r}`);
    } catch {}
  }
  return rel;
}

// Pixel size from a PNG, JPEG or WebP header, so pins can sit on the drawn
// image rather than on its letterbox. null when the bytes aren't understood.
export function sizeFromBytes(b) {
  const n = b.length;
  if (n > 24 && b[0] === 0x89 && b[1] === 0x50) {
    const w = ((b[16] << 24) | (b[17] << 16) | (b[18] << 8) | b[19]) >>> 0;
    const h = ((b[20] << 24) | (b[21] << 16) | (b[22] << 8) | b[23]) >>> 0;
    return w && h ? { w, h } : null;
  }
  if (n > 4 && b[0] === 0xff && b[1] === 0xd8) {
    let i = 2;
    while (i + 9 < n) {
      if (b[i] !== 0xff) {
        i++;
        continue;
      }
      const m = b[i + 1];
      if (m === 0xff) {
        i++;
        continue;
      }
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        const h = (b[i + 5] << 8) | b[i + 6];
        const w = (b[i + 7] << 8) | b[i + 8];
        return w && h ? { w, h } : null;
      }
      if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) i += 2;
      else i += 2 + ((b[i + 2] << 8) | b[i + 3]);
    }
    return null;
  }
  if (n > 30 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) {
    const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
    if (tag === "VP8 ") return { w: (b[26] | (b[27] << 8)) & 0x3fff, h: (b[28] | (b[29] << 8)) & 0x3fff };
    if (tag === "VP8L") {
      return {
        w: 1 + (b[21] | ((b[22] & 0x3f) << 8)),
        h: 1 + ((b[22] >> 6) | (b[23] << 2) | ((b[24] & 0x0f) << 10)),
      };
    }
    if (tag === "VP8X") {
      return {
        w: 1 + (b[24] | (b[25] << 8) | (b[26] << 16)),
        h: 1 + (b[27] | (b[28] << 8) | (b[29] << 16)),
      };
    }
  }
  return null;
}

export async function imageSize(rel) {
  try {
    return sizeFromBytes(await fs.readFile(`${appHome()}/${rel}`));
  } catch {
    return null;
  }
}

// ---- notes.json -------------------------------------------------------------
// { [absPath]: { status: "new" | "reviewed" | "approved", pins: [{ x, y, text }], strokes: [...] } }
// x and y are percentages of the image's width and height.

const notesPath = (folder) => join(dirOf(folder), NOTES);

export function readNotesRaw(folder, machine) {
  return readTextFile(notesPath(folder), on(machine));
}

export function parseNotes(raw) {
  try {
    const v = JSON.parse(raw ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

export function base64Utf8(text) {
  const bytes = [];
  for (const ch of text) {
    const c = ch.codePointAt(0);
    if (c < 0x80) bytes.push(c);
    else if (c < 0x800) bytes.push(0xc0 | (c >> 6), 0x80 | (c & 63));
    else if (c < 0x10000) bytes.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    else bytes.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
  }
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const n = (bytes[i] << 16) | ((bytes[i + 1] ?? 0) << 8) | (bytes[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? B64[(n >> 6) & 63] : "=";
    out += i + 2 < bytes.length ? B64[n & 63] : "=";
  }
  return out;
}

// Local: writeTextFile with the raw text last read (rejects when it changed
// since). Remote: writeTextFile is local-only, so the text goes over exec.
export async function writeNotesText(folder, machine, text, expectedRaw) {
  const path = notesPath(folder);
  if (!machine) {
    await writeTextFile(path, text, expectedRaw);
    return;
  }
  const r = await exec(
    "sh",
    ["-c", 'printf %s "$2" | base64 -d > "$1.tmp" && mv "$1.tmp" "$1"', "sh", path, base64Utf8(text)],
    { on: machine },
  );
  if (r.code !== 0) throw new Error(r.stderr.trim() || "could not write notes.json");
}

// ---- feedback ---------------------------------------------------------------

const pct = (n) => `${Math.round(n)}%`;
// At most `max` points of a freehand path, evenly spread, first and last kept.
const thin = (pts, max) => (pts.length <= max ? pts : Array.from({ length: max }, (_, i) => pts[Math.round((i * (pts.length - 1)) / (max - 1))]));

// blocks: [{ path, pins, strokes?, approve }] -> the message for the agent.
export function feedbackText(blocks) {
  return blocks
    .map(({ path, pins, strokes = [], approve }) => {
      const lines = [];
      if (pins.length || strokes.length) lines.push(`Feedback on draft: ${path}`);
      pins.forEach((p, i) => lines.push(`- pin ${i + 1} at (${pct(p.x)}, ${pct(p.y)}): ${p.text?.trim() || "(no note)"}`));
      if (strokes.length) lines.push("Drawn marks (percent of the image):");
      for (const s of strokes) {
        const at = (p) => `(${pct(p.x)}, ${pct(p.y)})`;
        if (s.tool === "pen" && s.pts?.length) lines.push(`- [pen] ${thin(s.pts, 12).map(at).join(" → ")}`);
        else if (s.tool === "line" && s.a && s.b) lines.push(`- [line] ${at(s.a)} → ${at(s.b)}`);
        else if (s.tool === "circle" && s.c) lines.push(`- [circle] center ${at(s.c)} r (${pct(s.rx)}, ${pct(s.ry)})`);
      }
      if (approve) lines.push(`Approved: ${path}`);
      return lines.join("\n");
    })
    .filter(Boolean)
    .join("\n\n");
}

// `address` is a core address: t4, or anton/t3 for a space on another machine.
export async function sendToAgent(address, text) {
  const r = await hc(["send", address, text]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || `hc send ${address} failed`);
}
