// Matching engine — faithful port of docs/dig-matching-reference.py (the
// annotated reference; keep behavior identical to it, not "improved").
// Verdicts: CONFIDENT (>=0.90, auto-add) | UNCERTAIN (>=0.70, never auto-add,
// return evidence) | REJECTED.

// ---------- metric primitives ----------

function lev(a, b) {
  if (a === b) return 0;
  if (!a) return b.length;
  if (!b) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur.push(Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] !== b[j - 1] ? 1 : 0)));
    }
    prev = cur;
  }
  return prev[b.length];
}

function levSim(a, b) {
  if (!a && !b) return 1.0;
  return 1.0 - lev(a, b) / Math.max(a.length, b.length);
}

// difflib.SequenceMatcher(None, a, b).ratio() equivalent. Junk-free; autojunk
// is skipped (it only engages in Python at len(b) >= 200, far beyond any
// normalized track title this pipeline compares).
function sequenceMatcherRatio(a, b) {
  if (!a && !b) return 1.0;
  const b2j = new Map();
  for (let j = 0; j < b.length; j++) {
    const c = b[j];
    if (!b2j.has(c)) b2j.set(c, []);
    b2j.get(c).push(j);
  }
  function findLongest(alo, ahi, blo, bhi) {
    let besti = alo, bestj = blo, bestsize = 0;
    let j2len = new Map();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map();
      for (const j of b2j.get(a[i]) || []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) || 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) { besti = i - k + 1; bestj = j - k + 1; bestsize = k; }
      }
      j2len = newj2len;
    }
    return [besti, bestj, bestsize];
  }
  let matches = 0;
  const queue = [[0, a.length, 0, b.length]];
  while (queue.length) {
    const [alo, ahi, blo, bhi] = queue.pop();
    const [i, j, k] = findLongest(alo, ahi, blo, bhi);
    if (k) {
      matches += k;
      queue.push([alo, i, blo, j]);
      queue.push([i + k, ahi, j + k, bhi]);
    }
  }
  return (2.0 * matches) / (a.length + b.length);
}

const indelRatio = sequenceMatcherRatio;

function toks(s) {
  return s.split(" ").filter(Boolean);
}

function tokenSortRatio(a, b) {
  return indelRatio(toks(a).sort().join(" "), toks(b).sort().join(" "));
}

// ---------- normalization ----------

const LIG = { "æ": "ae", "œ": "oe", "ø": "o", "ß": "ss", "đ": "d", "ł": "l", "þ": "th", "ð": "d", "ı": "i", "ŋ": "n", "ħ": "h", "ŧ": "t" };
const PUNCT_DELETE = new Set(["'", "’", "‘", "ʼ", "ʻ", "`", "´"]);
const QUOTES = { "“": '"', "”": '"', "″": '"', "–": "-", "—": "-", "−": "-", "…": " ", " ": " " };

export function norm(s) {
  if (!s) return "";
  s = s.toLowerCase();
  for (const [k, v] of Object.entries(QUOTES)) s = s.split(k).join(v);
  s = Array.from(s, (c) => LIG[c] ?? c).join("");
  s = s.normalize("NFKD");
  s = s.replace(/\p{M}/gu, "");
  s = s.normalize("NFKC");
  s = s.replace(/\s*&\s*/g, " and ");
  s = s.replace(/\s*\+\s*/g, " and ");
  s = Array.from(s, (c) => (PUNCT_DELETE.has(c) ? "" : c)).join("");
  s = s.replace(/[^0-9a-z぀-ヿ一-鿿가-힯]+/gu, " ");
  // leading track number — lookahead mirrors Python's Unicode \w (JS \w stays
  // ASCII even under /u, which wrongly kept the prefix before CJK titles)
  s = s.replace(/^\s*\d{1,2}\s+(?=[\p{L}\p{N}_])/u, "");
  return s.replace(/\s+/g, " ").trim();
}

const STOPWORDS = new Set(["the", "a", "an"]);

// ---------- version-tag lexicon ----------
// CLASS A: cosmetic packaging. Same master (or same enough). Strip, no penalty.
const CLASS_A = [
  /^\d{4} remaster(ed)?$/, /^remaster(ed)?( \d{4})?$/, /^remastered version$/,
  /^digitally remastered$/, /^\d{4} digital remaster$/,
  /^album version$/, /^original version$/, /^original mix$/, /^main version$/,
  /^bonus track$/, /^bonus$/, /^deluxe( edition)?$/, /^expanded( edition)?$/,
  /^\d+(st|nd|rd|th) anniversary( edition| remaster)?$/,
  /^explicit( version)?$/, /^stereo$/, /^mono( version)?$/,
  /^feat\b.*/, /^ft\b.*/, /^featuring\b.*/, /^with .*/,
  /^from .*/, /^music from .*/, /^original motion picture soundtrack$/,
];
// CLASS B: audio genuinely differs but it is still "the song as released". Penalize, never auto-add.
const CLASS_B = [
  /^radio edit$/, /^radio version$/, /^single version$/, /^single edit$/, /^edit$/,
  /^short version$/, /^extended( version| edit)?$/, /^full length version$/,
  /^clean( version)?$/, /^censored$/, /^\d{4} version$/, /^\d{4} mix$/,
];
// CLASS C: a DIFFERENT RECORDING. Must match on both sides or it is a veto.
const CLASS_C = [
  /\blive\b/, /\bacoustic\b/, /\bunplugged\b/, /\bdemo\b/, /\bsession[s]?\b/,
  /\bremix\b/, /^(?!(\d{4}|original|album|stereo|mono)\b).*\bmix\b/,
  /\brework\b/, /\bvip\b/, /\bdub\b/, /\bbootleg\b/, /\bflip\b/,
  /\binstrumental\b/, /\ba ?ca?pp?ella\b/, /\bkaraoke\b/, /\bcover\b/, /\btribute\b/,
  /\boriginally performed by\b/, /\bin the style of\b/, /\bmade famous by\b/,
  /\bsped up\b/, /\bslowed\b/, /\bnightcore\b/, /\breverb\b/, /\b8d\b/,
  /\bre ?recorded\b/, /\btaylors version\b/, /\breprise\b/, /\bmedley\b/,
  /\bworkout\b/, /\bpiano version\b/, /\bstring[s]? version\b/, /\blullaby\b/,
  /\bversion revisited\b/, /\bhome recording\b/, /\bradio session\b/, /\bbbc\b/,
];
const FEAT_RE = /^(feat|ft|featuring|w\/|with)\b[.\s]*(.+)$/i;

function classify(tag) {
  const t = norm(tag);
  if (!t) return [null, t];
  for (const p of CLASS_C) if (p.test(t)) return ["C", t];
  for (const p of CLASS_B) if (p.test(t)) return ["B", t];
  for (const p of CLASS_A) if (p.test(t)) return ["A", t];
  return ["U", t]; // unknown suffix
}

export function splitTitle(raw) {
  // -> { strict, loose, buckets: {A,B,C,U}, feats }
  const tags = [];
  const feats = [];
  let s = raw;
  for (const m of s.matchAll(/[([]([^()[\]]+)[)\]]/g)) tags.push(m[1]);
  s = s.replace(/[([][^()[\]]+[)\]]/g, " ");
  // spotify's display convention: " - <version>" tail segments
  const parts = s.split(/\s+-\s+/);
  const core = parts[0];
  tags.push(...parts.slice(1));
  const buckets = { A: [], B: [], C: [], U: [] };
  for (const t of tags) {
    const fm = FEAT_RE.exec(t.trim());
    if (fm) {
      // reference splits on a bare "x" (not \bx\b) — preserved verbatim
      feats.push(...norm(fm[2]).split(/\s*(?:,|&|\band\b|\+|x)\s*/));
      continue;
    }
    const [k, nt] = classify(t);
    if (k) buckets[k].push(nt);
  }
  const coreLoose = norm(core);
  const strict = norm(core) + (buckets.U.length ? " " + buckets.U.join(" ") : "");
  return { strict, loose: coreLoose, buckets, feats: feats.filter(Boolean) };
}

// ---------- comparison primitives ----------

function symSim(a, b) {
  // Symmetric, length-penalising core similarity.
  return Math.max(levSim(a, b), tokenSortRatio(a, b));
}

const TOKEN_SIM_MIN = 0.85;

function unmatchedContentTokens(a, b) {
  // Greedy bijective token pairing; returns [nUnmatchedA, nUnmatchedB].
  const A = toks(a).filter((t) => !STOPWORDS.has(t));
  const B = toks(b).filter((t) => !STOPWORDS.has(t));
  const pool = [...B];
  let ua = 0;
  for (const ta of A) {
    let best = 0.0, bi = null;
    for (let i = 0; i < pool.length; i++) {
      const s = levSim(ta, pool[i]);
      if (s > best) { best = s; bi = i; }
    }
    if (bi !== null && best >= TOKEN_SIM_MIN) pool.splice(bi, 1);
    else ua += 1;
  }
  return [ua, pool.length];
}

const ARTIST_SPLIT = /\s*(?:,|;|\/|\band\b|\bfeat\b|\bft\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\b|\bversus\b)\s*/;

function artistAtoms(names) {
  // Decompose possibly-compound artist strings into comparable atoms.
  // Applied identically to BOTH sides, so band names containing '&' survive.
  const out = [];
  for (const n of names) {
    const s = norm(n).replace(/^the /, "");
    for (let part of s.split(ARTIST_SPLIT)) {
      part = part.trim().replace(/^the /, "");
      if (part) out.push(part);
    }
  }
  return out;
}

function artistSim(wantedArtists, candArtists) {
  // -> [primaryScore, coverage] using atom decomposition on both sides.
  const W = artistAtoms(wantedArtists);
  const C = artistAtoms(candArtists);
  if (!W.length || !C.length) return [0.0, 0.0];
  const best = (w) => C.reduce((m, c) => Math.max(m, symSim(w, c)), 0.0);
  const primary = best(W[0]);
  const covered = W.filter((w) => best(w) >= 0.90).length;
  return [primary, covered / W.length];
}

function durationScore(dWant, dCand) {
  if (dWant == null || dCand == null) return null;
  const delta = Math.abs(dWant - dCand);
  if (delta <= 3000) return 1.0;
  return Math.max(0.0, 1.0 - (delta - 3000) / 27000.0);
}

function yearScore(yWant, yCand) {
  if (yWant == null || yCand == null) return null;
  const d = Math.abs(yWant - yCand);
  return d === 0 ? 1.0 : d === 1 ? 0.95 : d <= 2 ? 0.85 : d <= 5 ? 0.5 : 0.2;
}

// ---------- the algorithm ----------

const ARTIST_VETO = 0.60;
const ARTIST_MIN = 0.85;
const TITLE_MIN = 0.87;
const CONFIDENT = 0.90;
const UNCERTAIN = 0.70;
const DUR_VETO_MS = 20000;
const DUR_VETO_PCT = 0.15;

const setEq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

export function verify(wanted, cand) {
  const reasons = [];
  const w = splitTitle(wanted.title);
  const c = splitTitle(cand.name);

  // ---- G0 ISRC short-circuit (equality accepts; inequality is only weak
  // evidence — it falls through to the gates rather than rejecting)
  if (wanted.isrc && cand.isrc && wanted.isrc.toUpperCase() === cand.isrc.toUpperCase()) {
    return { verdict: "CONFIDENT", score: 1.0, reasons: ["isrc-exact"] };
  }

  // ---- G1 version-class gate: set equality, not a blocklist
  const wc = new Set(w.buckets.C);
  const cc = new Set(c.buckets.C);
  if (!setEq(wc, cc)) {
    const fmt = (s) => (s.size ? JSON.stringify([...s].sort()) : "-");
    return {
      verdict: "REJECTED", score: 0.0,
      reasons: [`version-class-mismatch wanted=${fmt(wc)} cand=${fmt(cc)}`],
    };
  }

  // ---- G2 artist gate
  const wArt = [...wanted.artists, ...w.feats];
  const cArt = [...cand.artists, ...c.feats];
  const [aPri, aCov] = artistSim(wArt, cArt);
  if (aPri < ARTIST_VETO) {
    return { verdict: "REJECTED", score: 0.0, reasons: [`artist-veto primary=${aPri.toFixed(2)}`] };
  }
  if (aPri < ARTIST_MIN) reasons.push(`artist-weak ${aPri.toFixed(2)}`);
  if (aCov < 1.0) reasons.push(`artist-coverage ${aCov.toFixed(2)}`);
  const aAvg = 0.7 * aPri + 0.3 * aCov;

  // ---- G3 title gate (strict first, then loose)
  let usedLoose = false;
  let tSim = symSim(w.strict, c.strict);
  const [ua, ub] = unmatchedContentTokens(w.strict, c.strict);
  if (!(tSim >= TITLE_MIN && ua === 0 && ub === 0)) {
    const t2 = symSim(w.loose, c.loose);
    const [ua2, ub2] = unmatchedContentTokens(w.loose, c.loose);
    if (t2 >= TITLE_MIN && ua2 === 0 && ub2 === 0 && (w.buckets.U.length || c.buckets.U.length)) {
      usedLoose = true;
      tSim = t2;
      reasons.push(`unknown-suffix-ignored ${JSON.stringify(c.buckets.U.length ? c.buckets.U : w.buckets.U)}`);
    } else {
      return {
        verdict: "REJECTED", score: 0.0,
        reasons: [`title-gate sim=${tSim.toFixed(2)} extra_w=${ua} extra_c=${ub}`],
      };
    }
  }

  // ---- G4 duration gate (veto only from trusted sources)
  const d = durationScore(wanted.duration_ms, cand.duration_ms);
  if (d !== null && wanted.duration_trusted) {
    const delta = Math.abs(wanted.duration_ms - cand.duration_ms);
    if (delta > DUR_VETO_MS && delta / Math.max(wanted.duration_ms, cand.duration_ms) > DUR_VETO_PCT) {
      return { verdict: "REJECTED", score: 0.0, reasons: [`duration-veto Δ=${(delta / 1000).toFixed(1)}s`] };
    }
  }

  // ---- score
  const parts = [["title", tSim, 0.40], ["artist", aAvg, 0.30]];
  if (d !== null) parts.push(["duration", d, 0.20]);
  if (wanted.album && cand.album) parts.push(["album", symSim(norm(wanted.album), norm(cand.album)), 0.05]);
  const ys = yearScore(wanted.year, cand.year);
  if (ys !== null) parts.push(["year", ys, 0.05]);
  const tw = parts.reduce((s, [, , wgt]) => s + wgt, 0);
  let score = parts.reduce((s, [, v, wgt]) => s + v * wgt, 0) / tw;

  // ---- penalties
  if (aCov < 1.0) score -= 0.10;
  const wb = new Set(w.buckets.B);
  const cb = new Set(c.buckets.B);
  if (!setEq(wb, cb)) {
    score -= 0.15;
    const fmt = (s) => (s.size ? JSON.stringify([...s].sort()) : "-");
    reasons.push(`variant-tag-mismatch wanted=${fmt(wb)} cand=${fmt(cb)}`);
  }
  if (usedLoose) score -= 0.12;
  if (wanted.explicit != null && cand.explicit != null && wanted.explicit !== cand.explicit) {
    score -= 0.02;
    reasons.push("explicit-flag-differs");
  }

  const verdict = score >= CONFIDENT ? "CONFIDENT" : score >= UNCERTAIN ? "UNCERTAIN" : "REJECTED";
  return { verdict, score: Math.round(score * 1000) / 1000, reasons: reasons.length ? reasons : ["clean"] };
}

// Rank every candidate for one wanted track. Returns the full evidence set so
// tools can explain doubt without re-deriving it: best pick plus scored
// alternatives, each carrying its own verdict/score/reasons.
export function verifyCandidates(wanted, candidates) {
  const order = { CONFIDENT: 0, UNCERTAIN: 1, REJECTED: 2 };
  const scored = candidates
    .map((cand) => ({ candidate: cand, ...verify(wanted, cand) }))
    .sort((a, b) => order[a.verdict] - order[b.verdict] || b.score - a.score);
  return { best: scored[0] ?? null, alternatives: scored.slice(1) };
}
