// main.ts is mend, the CLI SPEC.md specifies. It does sections 1 to 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, line matching at three tiers (section 5), unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7), V4A patches (section 8), JSON edits (section 9) and the all-or-nothing write
// (section 10). Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  /** Successful moves, as [old, new] pairs, for the `R` output line (section 2). */
  readonly moves: Array<[string, string]> = [];
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

// ---------- Section 5: files, lines, matching ----------

interface FileText {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileText {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileText): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

const stripTrail = (s: string): string => s.replace(/[ \t]+$/, '');
const stripBoth = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m ? m[0] : '';
};

function normLine(s: string, tier: number): string {
  return tier === 0 ? s : tier === 1 ? stripTrail(s) : stripBoth(s);
}

/** All 0-based positions at or after `from` where O occurs in F at the given tier. */
function occurrences(O: string[], F: string[], tier: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  const nO = O.map((l) => normLine(l, tier));
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (normLine(F[i + j]!, tier) !== nO[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, then 1, then 2; only 0 when strict) at which O occurs at or after `from`. */
function firstTier(O: string[], F: string[], from: number, strict: boolean): { tier: number; pos: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const pos = occurrences(O, F, t, from);
    if (pos.length > 0) return { tier: t, pos };
  }
  return null;
}

/** One line of N: `ctx` is its index into O when it is a context line, else null. */
interface NLine {
  text: string;
  ctx: number | null;
}

/**
 * Build the replacement lines: a context line is written as the file's own matched line, never the patch's;
 * at tier 2 every other line is re-indented from O's first line's leading whitespace to the file's.
 */
function buildNew(O: string[], N: NLine[], matched: string[], tier: number): string[] {
  const F = matched.length > 0 ? leadWs(matched[0]!) : '';
  const P = O.length > 0 ? leadWs(O[0]!) : '';
  return N.map((n) => {
    if (n.ctx !== null) return matched[n.ctx]!;
    if (tier !== 2) return n.text;
    const t = n.text;
    if (t === '' || t.trim() === '') return t;
    if (t.startsWith(P)) return F + t.slice(P.length);
    return t;
  });
}

function applyReplace(lines: string[], pos: number, O: string[], N: NLine[], tier: number): string[] {
  const matched = lines.slice(pos, pos + O.length);
  const repl = buildNew(O, N, matched, tier);
  return [...lines.slice(0, pos), ...repl, ...lines.slice(pos + O.length)];
}

/** True when a `\` line immediately follows the hunk/chunk's last context or `+` line. */
function backslashAfterLastCtxOrPlus(body: BodyLine[]): boolean {
  let last = -1;
  for (let j = 0; j < body.length; j++) {
    if (body[j]!.kind === ' ' || body[j]!.kind === '+') last = j;
  }
  if (last < 0) return false;
  return body[last + 1]?.kind === '\\';
}

interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
  /** True when the raw patch line was empty (a bare empty line, not a line holding a space). */
  empty: boolean;
}

function bodyLine(raw: string): BodyLine {
  if (raw === '') return { kind: ' ', text: '', empty: true };
  const c = raw[0]!;
  if (c === ' ' || c === '-' || c === '+' || c === '\\') return { kind: c, text: raw.slice(1), empty: false };
  throw new Error('not a body line');
}

/** Split a hunk/chunk body into its old lines O and its new lines N (with context markers). */
function splitBody(body: BodyLine[]): { O: string[]; N: NLine[] } {
  const O: string[] = [];
  const N: NLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      O.push(b.text);
      N.push({ text: b.text, ctx: O.length - 1 });
    } else if (b.kind === '-') {
      O.push(b.text);
    } else if (b.kind === '+') {
      N.push({ text: b.text, ctx: null });
    }
  }
  return { O, N };
}

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

// ---------- Section 6: unified diffs ----------

interface Hunk {
  /** Old start line A (1-based, may be 0). */
  a: number;
  body: BodyLine[];
}

interface UniSection {
  pairOld?: string | null;
  pairNew?: string | null;
  renameOld?: string;
  renameNew?: string;
  gitOld?: string;
  gitNew?: string;
  newFile: boolean;
  deletedFile: boolean;
  hunks: Hunk[];
}

const DIFF_GIT_RE = /^diff --git a\/(\S+) b\/(\S+)\s*$/;
const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function uniPath(raw: string): string | null {
  const t = raw.split('\t')[0]!.trim();
  if (t === '/dev/null') return null;
  return t.startsWith('a/') || t.startsWith('b/') ? t.slice(2) : t;
}

function parseUnified(lines: string[], strict: boolean): Edit[] {
  const sections: UniSection[] = [];
  let cur: UniSection | null = null;
  let inHeader = false;
  let headerHasPaths = false;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i]!;
    if (line.startsWith('diff --git ')) {
      const m = DIFF_GIT_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      cur = { gitOld: m[1]!, gitNew: m[2]!, newFile: false, deletedFile: false, hunks: [] };
      sections.push(cur);
      inHeader = true;
      headerHasPaths = false;
      i++;
      continue;
    }
    if (line.startsWith('--- ')) {
      const next = lines[i + 1] ?? '';
      if (next.startsWith('+++ ')) {
        if (cur !== null && inHeader && !headerHasPaths) {
          cur.pairOld = uniPath(line.slice(4));
          cur.pairNew = uniPath(next.slice(4));
          headerHasPaths = true;
          i += 2;
          continue;
        }
        cur = { pairOld: uniPath(line.slice(4)), pairNew: uniPath(next.slice(4)), newFile: false, deletedFile: false, hunks: [] };
        sections.push(cur);
        inHeader = true;
        headerHasPaths = true;
        i += 2;
        continue;
      }
      if (cur !== null && inHeader) throw new Exit2(`error: parse ${i + 2}`);
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (cur === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = HUNK_RE.exec(line);
      if (!m) throw new Exit2(`error: parse ${i + 1}`);
      const a = parseInt(m[1]!, 10);
      i++;
      const body: BodyLine[] = [];
      while (i < n) {
        const bl = lines[i]!;
        if (bl.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')) break;
        if (bl === '') {
          body.push({ kind: ' ', text: '', empty: true });
          i++;
          continue;
        }
        const c = bl[0]!;
        if (c === ' ' || c === '-' || c === '+' || c === '\\') {
          body.push({ kind: c, text: bl.slice(1), empty: false });
          i++;
          continue;
        }
        break;
      }
      while (body.length > 0 && body[body.length - 1]!.empty) body.pop();
      cur.hunks.push({ a, body });
      inHeader = false;
      continue;
    }
    if (cur !== null && inHeader) {
      if (line.startsWith('rename from ')) cur.renameOld = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) cur.renameNew = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) cur.newFile = true;
      else if (line.startsWith('deleted file mode')) cur.deletedFile = true;
      // index, old mode, new mode, similarity index, dissimilarity index, Index: and any other line: ignored.
      i++;
      continue;
    }
    i++;
  }
  return sections.map((s) => uniEdit(s, strict));
}

function uniEdit(s: UniSection, strict: boolean): Edit {
  const old = s.pairOld !== undefined ? s.pairOld : s.renameOld !== undefined ? s.renameOld : s.gitOld ?? null;
  const nw = s.pairNew !== undefined ? s.pairNew : s.renameNew !== undefined ? s.renameNew : s.gitNew ?? null;
  // Degenerate section naming no file at all: a no-op edit (the specification names no behaviour for it).
  if (old === null && nw === null) return () => {};
  const isCreate = (old === null || s.newFile) && nw !== null;
  const isDelete = !isCreate && (nw === null || s.deletedFile);
  if (isCreate) {
    const np = nw!;
    return (tree) => {
      if (!safe(np)) throw new Fail('unsafe', np);
      if (tree.get(np) !== null) throw new Fail('exists', np);
      const plus: string[] = [];
      let lastPlus: { h: number; j: number } | null = null;
      s.hunks.forEach((h, hi) => {
        h.body.forEach((b, j) => {
          if (b.kind === '+') {
            plus.push(b.text);
            lastPlus = { h: hi, j };
          }
        });
      });
      let noFinal = false;
      if (lastPlus !== null) {
        const h = s.hunks[lastPlus.h]!;
        noFinal = h.body[lastPlus.j + 1]?.kind === '\\';
      }
      tree.now.set(np, plus.length === 0 ? '' : plus.join('\n') + (noFinal ? '' : '\n'));
    };
  }
  if (isDelete) {
    const op = old!;
    return (tree) => {
      if (!safe(op)) throw new Fail('unsafe', op);
      if (tree.get(op) === null) throw new Fail('missing', op);
      tree.now.set(op, null);
    };
  }
  const op = old!;
  const np = nw!;
  const isMove = np !== op;
  return (tree) => {
    if (!safe(op)) throw new Fail('unsafe', op);
    if (isMove && !safe(np)) throw new Fail('unsafe', np);
    const before = tree.get(op);
    if (before === null) throw new Fail('missing', op);
    if (isMove && tree.get(np) !== null) throw new Fail('exists', np);
    const f = splitFile(before);
    let lines = f.lines;
    let final = f.final;
    let d = 0;
    for (const h of s.hunks) {
      const { O, N } = splitBody(h.body);
      if (O.length > 0) {
        const found = firstTier(O, lines, 0, strict);
        if (!found) throw new Fail('no-match', op);
        const target = h.a - 1 + d;
        let best = found.pos[0]!;
        let bestDist = Math.abs(best - target);
        for (const p of found.pos) {
          const dist = Math.abs(p - target);
          if (dist < bestDist) {
            best = p;
            bestDist = dist;
          }
        }
        const touchesEnd = best + O.length === lines.length;
        lines = applyReplace(lines, best, O, N, found.tier);
        if (touchesEnd) final = !backslashAfterLastCtxOrPlus(h.body);
        d += N.length - O.length;
      } else {
        const ins = Math.min(h.a + d, lines.length);
        const repl = buildNew([], N, [], 0);
        lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
        if (ins === lines.length) final = !backslashAfterLastCtxOrPlus(h.body);
        d += N.length;
      }
    }
    const content = joinFile({ lines, br: f.br, final });
    if (isMove) {
      tree.now.set(np, content);
      tree.now.set(op, null);
      tree.moves.push([op, np]);
    } else {
      tree.now.set(op, content);
    }
  };
}

// ---------- Section 7: SEARCH/REPLACE blocks ----------

function srEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    const f = splitFile(before);
    const found = firstTier(oldLines, f.lines, 0, strict);
    if (!found) throw new Fail('no-match', path);
    if (found.pos.length > 1) throw new Fail('ambiguous', path);
    const pos = found.pos[0]!;
    const lines = applyReplace(
      f.lines,
      pos,
      oldLines,
      newLines.map((t) => ({ text: t, ctx: null })),
      found.tier,
    );
    tree.now.set(path, joinFile({ lines, br: f.br, final: f.final }));
  };
}

function parseSearchReplace(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevReplaceEnd = -1;
  let prevPath: string | null = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') {
      i++;
      continue;
    }
    const searchIdx = i;
    let eq = -1;
    let rep = -1;
    for (let j = searchIdx + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (eq < 0) {
        if (t === '=======') eq = j;
        else if (t === '>>>>>>> REPLACE') throw new Exit2(`error: parse ${searchIdx + 1}`);
      } else if (t === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${searchIdx + 1}`);
    const oldLines = lines.slice(searchIdx + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    let path: string | null = null;
    for (let j = searchIdx - 1; j > prevReplaceEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      const t = l.trim();
      if (t.startsWith('```')) continue;
      path = t;
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${searchIdx + 1}`);
      path = prevPath;
    }
    prevPath = path;
    prevReplaceEnd = rep;
    edits.push(srEdit(path, oldLines, newLines, strict));
    i = rep + 1;
  }
  return edits;
}

// ---------- Section 8: V4A patches ----------

interface VChunk {
  anchor: string | null;
  eof: boolean;
  body: BodyLine[];
}

interface VSection {
  kind: 'add' | 'delete' | 'update';
  path: string;
  lineNo: number;
  raw: Array<{ text: string; no: number }>;
}

const V_START_RE = /^\*\*\* (Add File|Delete File|Update File): (.*)$/;

function findAnchor(anchor: string, F: string[], from: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const a = normLine(anchor, t);
    for (let i = from; i < F.length; i++) {
      if (normLine(F[i]!, t) === a) return i;
    }
  }
  return -1;
}

function v4aEdit(s: VSection, strict: boolean): Edit {
  if (s.kind === 'add') {
    const fileLines: string[] = [];
    for (const { text, no } of s.raw) {
      if (text === '') fileLines.push('');
      else if (text.startsWith('+')) fileLines.push(text.slice(1));
      else throw new Exit2(`error: parse ${no}`);
    }
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, fileLines.length === 0 ? '' : fileLines.join('\n') + '\n');
    };
  }
  if (s.kind === 'delete') {
    for (const { text, no } of s.raw) {
      if (!blank(text)) throw new Exit2(`error: parse ${no}`);
    }
    const path = s.path;
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  // update
  let idx = 0;
  while (idx < s.raw.length && blank(s.raw[idx]!.text)) idx++;
  let moveTo: string | null = null;
  if (idx < s.raw.length && s.raw[idx]!.text.startsWith('*** Move to: ')) {
    moveTo = s.raw[idx]!.text.slice('*** Move to: '.length).trim();
    idx++;
  }
  const chunks: VChunk[] = [];
  let chunk: VChunk | null = null;
  const isBodyLine = (t: string): boolean => t === '' || t.startsWith(' ') || t.startsWith('-') || t.startsWith('+');
  while (idx < s.raw.length) {
    const { text, no } = s.raw[idx]!;
    if (text.startsWith('@@')) {
      chunk = { anchor: text.slice(2).trim(), eof: false, body: [] };
      if (chunk.anchor === '') chunk.anchor = null;
      chunks.push(chunk);
      idx++;
      continue;
    }
    if (text === '*** End of File') {
      if (chunk === null) throw new Exit2(`error: parse ${no}`);
      chunk.eof = true;
      chunk = null;
      idx++;
      continue;
    }
    if (isBodyLine(text)) {
      if (chunk === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${no}`);
        chunk = { anchor: null, eof: false, body: [] };
        chunks.push(chunk);
      }
      chunk.body.push(bodyLine(text));
      idx++;
      continue;
    }
    throw new Exit2(`error: parse ${no}`);
  }
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${s.lineNo}`);
  const path = s.path;
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const before = tree.get(path);
    if (before === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(before);
    let lines = f.lines;
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(ch.anchor, lines, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      const { O, N } = splitBody(ch.body);
      if (O.length > 0) {
        const found = firstTier(O, lines, cursor, strict);
        let pos: number | null = null;
        let tier = 0;
        if (found) {
          tier = found.tier;
          for (const p of found.pos) {
            if (ch.eof && p + O.length !== lines.length) continue;
            pos = p;
            break;
          }
        }
        if (pos === null) throw new Fail('no-match', path);
        lines = applyReplace(lines, pos, O, N, tier);
        cursor = pos + N.length;
      } else {
        const ins = ch.eof ? lines.length : cursor;
        const repl = buildNew([], N, [], 0);
        lines = [...lines.slice(0, ins), ...repl, ...lines.slice(ins)];
        cursor = ins + N.length;
      }
    }
    const content = joinFile({ lines, br: f.br, final: f.final });
    if (moveTo !== null) {
      tree.now.set(moveTo, content);
      tree.now.set(path, null);
      tree.moves.push([path, moveTo]);
    } else {
      tree.now.set(path, content);
    }
  };
}

function parseV4a(lines: string[], strict: boolean): Edit[] {
  const n = lines.length;
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let j = n - 1; j >= 0; j--) {
    if (!blank(lines[j]!)) {
      last = j;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${n + 1}`);
  const sections: VSection[] = [];
  let cur: VSection | null = null;
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    const m = V_START_RE.exec(line);
    if (m) {
      cur = {
        kind: m[1] === 'Add File' ? 'add' : m[1] === 'Delete File' ? 'delete' : 'update',
        path: m[2]!.trim(),
        lineNo: i + 1,
        raw: [],
      };
      sections.push(cur);
      i++;
      continue;
    }
    if (cur === null) {
      if (blank(line)) {
        i++;
        continue;
      }
      throw new Exit2(`error: parse ${i + 1}`);
    }
    cur.raw.push({ text: line, no: i + 1 });
    i++;
  }
  for (const s of sections) {
    while (s.raw.length > 0 && blank(s.raw[s.raw.length - 1]!.text)) s.raw.pop();
  }
  return sections.map((s) => v4aEdit(s, strict));
}

// ---------- Section 10: order, atomicity, output ----------

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits =
      kind === 'json'
        ? jsonEdits(text, lines)
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    const beforeMoves = tree.moves.length;
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      tree.moves.length = beforeMoves;
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed = [...tree.now.keys()].filter((p) => tree.original(p) !== tree.now.get(p));
  // A move that succeeded is one `R` line, replacing that pair's `D` and `A` lines, sorting by <new>.
  const moveNew = new Map<string, string>();
  for (const [o, n] of tree.moves) {
    if (tree.original(o) !== null && tree.now.get(o) === null && tree.original(n) === null && tree.now.get(n) !== null) {
      moveNew.set(n, o);
    }
  }
  interface Row {
    key: string;
    line: string;
  }
  const rows: Row[] = [];
  for (const p of changed) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (moveNew.has(p)) {
      rows.push({ key: p, line: `R ${moveNew.get(p)} -> ${p}` });
      continue;
    }
    if (was !== null && now === null && tree.moves.some(([o, n]) => o === p && moveNew.has(n))) continue;
    rows.push({ key: p, line: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  rows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  if (!check) {
    for (const p of changed) {
      if (tree.now.get(p) === null) rmSync(p, { force: true });
    }
    for (const p of changed) {
      const now = tree.now.get(p)!;
      if (now !== null) {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}

const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
