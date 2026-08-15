#!/usr/bin/env python3
"""Reference implementation + measurement harness for music-match verification."""
import re, unicodedata, difflib, itertools

# ---------- metric zoo (pure python, no deps) ----------
def lev(a, b):
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        cur = [i]
        for j, cb in enumerate(b, 1):
            cur.append(min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (ca != cb)))
        prev = cur
    return prev[-1]

def lev_sim(a, b):
    if not a and not b: return 1.0
    return 1.0 - lev(a, b) / max(len(a), len(b))

def indel_ratio(a, b):          # what rapidfuzz fuzz.ratio uses (difflib-equivalent family)
    if not a and not b: return 1.0
    return difflib.SequenceMatcher(None, a, b).ratio()

def jaro(a, b):
    if a == b: return 1.0
    if not a or not b: return 0.0
    md = max(len(a), len(b)) // 2 - 1
    if md < 0: md = 0
    af = [False]*len(a); bf = [False]*len(b); m = 0
    for i, ca in enumerate(a):
        for j in range(max(0, i-md), min(len(b), i+md+1)):
            if not bf[j] and b[j] == ca:
                af[i] = bf[j] = True; m += 1; break
    if m == 0: return 0.0
    t = 0; k = 0
    for i, ca in enumerate(a):
        if af[i]:
            while not bf[k]: k += 1
            if ca != b[k]: t += 1
            k += 1
    t //= 2
    return (m/len(a) + m/len(b) + (m-t)/m) / 3

def jaro_winkler(a, b, p=0.1):
    j = jaro(a, b)
    pref = 0
    for ca, cb in zip(a, b):
        if ca != cb: break
        pref += 1
        if pref == 4: break
    return j + pref * p * (1 - j)

def toks(s): return [t for t in s.split() if t]

def token_sort_ratio(a, b):
    return indel_ratio(" ".join(sorted(toks(a))), " ".join(sorted(toks(b))))

def token_set_ratio(a, b):      # fuzzywuzzy/rapidfuzz semantics
    A, B = set(toks(a)), set(toks(b))
    inter = " ".join(sorted(A & B))
    ra = (inter + " " + " ".join(sorted(A - B))).strip()
    rb = (inter + " " + " ".join(sorted(B - A))).strip()
    return max(indel_ratio(inter, ra), indel_ratio(inter, rb), indel_ratio(ra, rb))

def jaccard(a, b):
    A, B = set(toks(a)), set(toks(b))
    return len(A & B) / len(A | B) if (A | B) else 1.0

def ngrams(s, n=3):
    s = f"  {s}  "
    return [s[i:i+n] for i in range(len(s)-n+1)]

def trigram_dice(a, b):
    A, B = ngrams(a), ngrams(b)
    from collections import Counter
    ca, cb = Counter(A), Counter(B)
    inter = sum((ca & cb).values())
    return 2*inter/(len(A)+len(B)) if (A or B) else 1.0

def bidi_substring(a, b):       # THE BUG under audit
    return a in b or b in a

# ---------- normalization ----------
_LIG = {'æ':'ae','œ':'oe','ø':'o','ß':'ss','đ':'d','ł':'l','þ':'th','ð':'d','ı':'i','ŋ':'n','ħ':'h','ŧ':'t','œ':'oe'}
_PUNCT_DELETE = "'’‘ʼʻ`´"          # apostrophes: delete, never split words
_QUOTES = {'“':'"','”':'"','″':'"','–':'-','—':'-','−':'-','…':' ',' ':' '}

def norm(s: str) -> str:
    if not s: return ""
    s = s.casefold()
    for k, v in _QUOTES.items(): s = s.replace(k, v)
    s = "".join(_LIG.get(c, c) for c in s)
    s = unicodedata.normalize("NFKD", s)
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"\s*&\s*", " and ", s)
    s = re.sub(r"\s*\+\s*", " and ", s)
    s = "".join("" if c in _PUNCT_DELETE else c for c in s)
    s = re.sub(r"[^0-9a-z぀-ヿ一-鿿가-힯]+", " ", s)
    s = re.sub(r"^\s*\d{1,2}\s+(?=\w)", "", s)              # leading track number
    return re.sub(r"\s+", " ", s).strip()

STOPWORDS = {"the", "a", "an"}

# ---------- version-tag lexicon ----------
# CLASS A: cosmetic packaging. Same master (or same enough). Strip, no penalty.
CLASS_A = [
    r"^\d{4} remaster(ed)?$", r"^remaster(ed)?( \d{4})?$", r"^remastered version$",
    r"^digitally remastered$", r"^\d{4} digital remaster$",
    r"^album version$", r"^original version$", r"^original mix$", r"^main version$",
    r"^bonus track$", r"^bonus$", r"^deluxe( edition)?$", r"^expanded( edition)?$",
    r"^\d+(st|nd|rd|th) anniversary( edition| remaster)?$",
    r"^explicit( version)?$", r"^stereo$", r"^mono( version)?$",
    r"^feat\b.*", r"^ft\b.*", r"^featuring\b.*", r"^with .*",
    r"^from .*", r"^music from .*", r"^original motion picture soundtrack$",
]
# CLASS B: audio genuinely differs but it is still "the song as released". Penalize, never auto-add.
CLASS_B = [
    r"^radio edit$", r"^radio version$", r"^single version$", r"^single edit$", r"^edit$",
    r"^short version$", r"^extended( version| edit)?$", r"^full length version$",
    r"^clean( version)?$", r"^censored$", r"^\d{4} version$", r"^\d{4} mix$",
]
# CLASS C: a DIFFERENT RECORDING. Must match on both sides or it is a veto.
CLASS_C = [
    r"\blive\b", r"\bacoustic\b", r"\bunplugged\b", r"\bdemo\b", r"\bsession[s]?\b",
    r"\bremix\b", r"^(?!(\d{4}|original|album|stereo|mono)\b).*\bmix\b",
    r"\brework\b", r"\bvip\b", r"\bdub\b", r"\bbootleg\b", r"\bflip\b",
    r"\binstrumental\b", r"\ba ?ca?pp?ella\b", r"\bkaraoke\b", r"\bcover\b", r"\btribute\b",
    r"\boriginally performed by\b", r"\bin the style of\b", r"\bmade famous by\b",
    r"\bsped up\b", r"\bslowed\b", r"\bnightcore\b", r"\breverb\b", r"\b8d\b",
    r"\bre ?recorded\b", r"\btaylors version\b", r"\breprise\b", r"\bmedley\b",
    r"\bworkout\b", r"\bpiano version\b", r"\bstring[s]? version\b", r"\blullaby\b",
    r"\bversion revisited\b", r"\bhome recording\b", r"\bradio session\b", r"\bbbc\b",
]
FEAT_RE = re.compile(r"\b(feat|ft|featuring|w/|with)\b[.\s]*(.+)$", re.I)

def classify(tag: str):
    t = norm(tag)
    if not t: return None, t
    for p in CLASS_C:
        if re.search(p, t): return "C", t
    for p in CLASS_B:
        if re.match(p, t): return "B", t
    for p in CLASS_A:
        if re.match(p, t): return "A", t
    return "U", t                                            # unknown suffix

def split_title(raw: str):
    """-> (core_strict, core_loose, {A:[],B:[],C:[],U:[]}, feats[])"""
    tags, feats = [], []
    s = raw
    # bracketed / parenthesised groups
    for m in re.finditer(r"[\(\[]([^\(\)\[\]]+)[\)\]]", s):
        tags.append(m.group(1))
    s = re.sub(r"[\(\[][^\(\)\[\]]+[\)\]]", " ", s)
    # spotify's display convention: " - <version>" tail segments
    parts = re.split(r"\s+-\s+", s)
    core = parts[0]
    tags.extend(parts[1:])
    buckets = {"A": [], "B": [], "C": [], "U": []}
    for t in tags:
        fm = FEAT_RE.match(t.strip())
        if fm:
            feats.extend(re.split(r"\s*(?:,|&|\band\b|\+|x)\s*", norm(fm.group(2))))
            continue
        k, nt = classify(t)
        if k: buckets[k].append(nt)
    core_strict = norm(core)
    if buckets["U"]:
        core_loose = core_strict
    else:
        core_loose = core_strict
    # a trailing " - Unknown" tail is retained in strict, dropped in loose
    core_strict_full = norm(re.split(r"\s+-\s+", raw)[0]) if buckets["U"] else core_strict
    strict = norm(core) + ((" " + " ".join(buckets["U"])) if buckets["U"] else "")
    return strict, core_loose, buckets, [f for f in feats if f]

# ---------- comparison primitives ----------
def sym_sim(a, b):
    """Symmetric, length-penalising core similarity."""
    return max(lev_sim(a, b), token_sort_ratio(a, b))

TOKEN_SIM_MIN = 0.85

def unmatched_content_tokens(a, b):
    """Greedy bijective token pairing; returns (n_unmatched_a, n_unmatched_b)."""
    A = [t for t in toks(a) if t not in STOPWORDS]
    B = [t for t in toks(b) if t not in STOPWORDS]
    pool = list(B); ua = 0
    for ta in A:
        best, bi = 0.0, None
        for i, tb in enumerate(pool):
            s = lev_sim(ta, tb)
            if s > best: best, bi = s, i
        if bi is not None and best >= TOKEN_SIM_MIN: pool.pop(bi)
        else: ua += 1
    return ua, len(pool)

ARTIST_SPLIT = re.compile(r"\s*(?:,|;|/|\band\b|\bfeat\b|\bft\b|\bfeaturing\b|\bwith\b|\bx\b|\bvs\b|\bversus\b)\s*")

def artist_atoms(names):
    """Decompose a list of possibly-compound artist strings into comparable atoms.
    Applied identically to BOTH sides, so band names containing '&' survive."""
    out = []
    for n in names:
        s = re.sub(r"^the ", "", norm(n))
        for part in ARTIST_SPLIT.split(s):
            part = re.sub(r"^the ", "", part.strip())
            if part: out.append(part)
    return out

def artist_sim(wanted_artists, cand_artists):
    """-> (primary_score, coverage) using atom decomposition on both sides."""
    W = artist_atoms(wanted_artists)
    C = artist_atoms(cand_artists)
    if not W or not C: return 0.0, 0.0
    best = lambda w: max((sym_sim(w, c) for c in C), default=0.0)
    primary = best(W[0])
    covered = sum(1 for w in W if best(w) >= 0.90)
    return primary, covered / len(W)

def duration_score(d_want, d_cand):
    if d_want is None or d_cand is None: return None
    delta = abs(d_want - d_cand)
    if delta <= 3000: return 1.0
    return max(0.0, 1.0 - (delta - 3000) / 27000.0)

def year_score(y_want, y_cand):
    if y_want is None or y_cand is None: return None
    d = abs(y_want - y_cand)
    return 1.0 if d == 0 else 0.95 if d == 1 else 0.85 if d <= 2 else 0.5 if d <= 5 else 0.2

# ---------- the algorithm ----------
ARTIST_VETO = 0.60
ARTIST_MIN  = 0.85
TITLE_MIN   = 0.87
CONFIDENT   = 0.90
UNCERTAIN   = 0.70
DUR_VETO_MS = 20000
DUR_VETO_PCT = 0.15

def verify(wanted, cand):
    reasons = []
    w_core_s, w_core_l, w_tags, w_feats = split_title(wanted["title"])
    c_core_s, c_core_l, c_tags, c_feats = split_title(cand["name"])

    # ---- G0 ISRC short-circuit
    if wanted.get("isrc") and cand.get("isrc") and wanted["isrc"].upper() == cand["isrc"].upper():
        return dict(verdict="CONFIDENT", score=1.0, reasons=["isrc-exact"])

    # ---- G1 version-class gate
    wc, cc = set(w_tags["C"]), set(c_tags["C"])
    if wc != cc:
        # allow set-equality only; a C tag on either side alone is fatal
        return dict(verdict="REJECTED", score=0.0,
                    reasons=[f"version-class-mismatch wanted={sorted(wc) or '-'} cand={sorted(cc) or '-'}"])

    # ---- G2 artist gate
    w_art = wanted["artists"] + w_feats
    c_art = cand["artists"] + c_feats
    a_pri, a_cov = artist_sim(w_art, c_art)
    if a_pri < ARTIST_VETO:
        return dict(verdict="REJECTED", score=0.0, reasons=[f"artist-veto primary={a_pri:.2f}"])
    if a_pri < ARTIST_MIN:
        reasons.append(f"artist-weak {a_pri:.2f}")
    if a_cov < 1.0:
        reasons.append(f"artist-coverage {a_cov:.2f}")
    a_avg = 0.7 * a_pri + 0.3 * a_cov

    # ---- G3 title gate (strict first, then loose)
    used_loose = False
    t_sim = sym_sim(w_core_s, c_core_s)
    ua, ub = unmatched_content_tokens(w_core_s, c_core_s)
    if not (t_sim >= TITLE_MIN and ua == 0 and ub == 0):
        t2 = sym_sim(w_core_l, c_core_l)
        ua2, ub2 = unmatched_content_tokens(w_core_l, c_core_l)
        if t2 >= TITLE_MIN and ua2 == 0 and ub2 == 0 and (w_tags["U"] or c_tags["U"]):
            used_loose = True; t_sim = t2
            reasons.append(f"unknown-suffix-ignored {c_tags['U'] or w_tags['U']}")
        else:
            return dict(verdict="REJECTED", score=0.0,
                        reasons=[f"title-gate sim={t_sim:.2f} extra_w={ua} extra_c={ub}"])

    # ---- G4 duration gate
    d = duration_score(wanted.get("duration_ms"), cand.get("duration_ms"))
    if d is not None and wanted.get("duration_trusted"):
        delta = abs(wanted["duration_ms"] - cand["duration_ms"])
        if delta > DUR_VETO_MS and delta / max(wanted["duration_ms"], cand["duration_ms"]) > DUR_VETO_PCT:
            return dict(verdict="REJECTED", score=0.0, reasons=[f"duration-veto Δ={delta/1000:.1f}s"])

    # ---- score
    parts = [("title", t_sim, 0.40), ("artist", a_avg, 0.30)]
    if d is not None: parts.append(("duration", d, 0.20))
    if wanted.get("album") and cand.get("album"):
        parts.append(("album", sym_sim(norm(wanted["album"]), norm(cand["album"])), 0.05))
    ys = year_score(wanted.get("year"), cand.get("year"))
    if ys is not None: parts.append(("year", ys, 0.05))
    tw = sum(w for _, _, w in parts)
    score = sum(v*w for _, v, w in parts) / tw

    # ---- penalties
    if a_cov < 1.0:
        score -= 0.10
    if set(w_tags["B"]) != set(c_tags["B"]):
        score -= 0.15; reasons.append(f"variant-tag-mismatch wanted={sorted(w_tags['B']) or '-'} cand={sorted(c_tags['B']) or '-'}")
    if used_loose: score -= 0.12
    if wanted.get("explicit") is not None and cand.get("explicit") is not None \
       and wanted["explicit"] != cand["explicit"]:
        score -= 0.02; reasons.append("explicit-flag-differs")

    verdict = "CONFIDENT" if score >= CONFIDENT else "UNCERTAIN" if score >= UNCERTAIN else "REJECTED"
    return dict(verdict=verdict, score=round(score, 3), reasons=reasons or ["clean"])


# ---------- measurement: what the naive metrics say ----------
PAIRS = [
    ("sweetgrass", "grass"), ("sweet grass", "grass"), ("alive", "stayin alive"),
    ("love", "love song"), ("creep", "creep"), ("hurt", "hurt"),
    ("the sound of silence", "the sounds of silence"),
    ("dont stop me now", "dont stop me now"),
    ("bohemian rhapsody", "bohemian rhapsody"),
    ("smells like teen spirit", "smells like teen spirit"),
]

def metric_table():
    print(f"{'a':<24}{'b':<22}{'bidi-sub':>9}{'lev':>7}{'indel':>7}{'jw':>7}{'tsort':>7}{'tset':>7}{'jacc':>7}{'tri':>7}")
    for a, b in PAIRS:
        print(f"{a:<24}{b:<22}{str(bidi_substring(a,b)):>9}{lev_sim(a,b):>7.2f}{indel_ratio(a,b):>7.2f}"
              f"{jaro_winkler(a,b):>7.2f}{token_sort_ratio(a,b):>7.2f}{token_set_ratio(a,b):>7.2f}"
              f"{jaccard(a,b):>7.2f}{trigram_dice(a,b):>7.2f}")

# ---------- test suite ----------
T = lambda **k: k
CASES = [
 ("Sweetgrass vs Grass (the live bug)",
  T(title="Sweetgrass", artists=["Kaitlyn Aurelia Smith"]),
  T(name="Grass", artists=["Kaitlyn Aurelia Smith"]), "REJECTED"),
 ("Grass vs Sweetgrass (reverse containment)",
  T(title="Grass", artists=["Animal Collective"]),
  T(name="Sweetgrass", artists=["Animal Collective"]), "REJECTED"),
 ("Two-token containment: Alive vs Stayin' Alive",
  T(title="Alive", artists=["Pearl Jam"]),
  T(name="Stayin' Alive", artists=["Pearl Jam"]), "REJECTED"),
 ("Remaster suffix, Spotify dash form",
  T(title="Bohemian Rhapsody", artists=["Queen"], duration_ms=354000),
  T(name="Bohemian Rhapsody - Remastered 2011", artists=["Queen"], duration_ms=354320), "CONFIDENT"),
 ("Remaster suffix, parenthetical form",
  T(title="In the Air Tonight", artists=["Phil Collins"], duration_ms=336000),
  T(name="In the Air Tonight (2015 Remastered)", artists=["Phil Collins"], duration_ms=335000), "CONFIDENT"),
 ("Live version is a different recording",
  T(title="Hotel California", artists=["Eagles"], duration_ms=391000),
  T(name="Hotel California - Live", artists=["Eagles"], duration_ms=428000), "REJECTED"),
 ("Acoustic version",
  T(title="Everlong", artists=["Foo Fighters"]),
  T(name="Everlong - Acoustic Version", artists=["Foo Fighters"]), "REJECTED"),
 ("Remix",
  T(title="Blinding Lights", artists=["The Weeknd"]),
  T(name="Blinding Lights (Chromatics Remix)", artists=["The Weeknd"]), "REJECTED"),
 ("Cover by a different artist",
  T(title="Hurt", artists=["Nine Inch Nails"], duration_ms=373000),
  T(name="Hurt", artists=["Johnny Cash"], duration_ms=218000), "REJECTED"),
 ("Cover, near-identical duration (artist gate must carry it)",
  T(title="Africa", artists=["Toto"], duration_ms=295000),
  T(name="Africa", artists=["Weezer"], duration_ms=272000), "REJECTED"),
 ("Karaoke soundalike",
  T(title="Wonderwall", artists=["Oasis"]),
  T(name="Wonderwall (Originally Performed by Oasis) [Karaoke Version]",
    artists=["Ameritz Karaoke Standards"]), "REJECTED"),
 ("feat. in candidate title, artist in wanted field",
  T(title="Goosebumps", artists=["Travis Scott", "Kendrick Lamar"], duration_ms=243000),
  T(name="goosebumps (feat. Kendrick Lamar)", artists=["Travis Scott"], duration_ms=243837), "CONFIDENT"),
 ("feat. in wanted title, artist in candidate field",
  T(title="Where Is the Love? (feat. Justin Timberlake)", artists=["Black Eyed Peas"], duration_ms=270000),
  T(name="Where Is The Love?", artists=["Black Eyed Peas", "Justin Timberlake"], duration_ms=272000), "CONFIDENT"),
 ("Accents + ampersand + article",
  T(title="Déjà Vu", artists=["Beyoncé & Jay-Z"], duration_ms=242000),
  T(name="Deja Vu", artists=["Beyonce", "JAY-Z"], duration_ms=242000), "CONFIDENT"),
 ("Curly vs straight apostrophe, case",
  T(title="Don’t Stop Me Now", artists=["Queen"], duration_ms=209000),
  T(name="DON'T STOP ME NOW", artists=["Queen"], duration_ms=209413), "CONFIDENT"),
 ("Leading 'The' in artist only",
  T(title="Take Five", artists=["Dave Brubeck Quartet"], duration_ms=324000),
  T(name="Take Five", artists=["The Dave Brubeck Quartet"], duration_ms=324000), "CONFIDENT"),
 ("Punctuation-only title difference",
  T(title="Hey Ya!", artists=["OutKast"], duration_ms=235000),
  T(name="Hey Ya", artists=["Outkast"], duration_ms=235213), "CONFIDENT"),
 ("Radio edit, 2 minutes shorter — duration confirms it is a different cut",
  T(title="One More Time", artists=["Daft Punk"], duration_ms=320000),
  T(name="One More Time - Radio Edit", artists=["Daft Punk"], duration_ms=200000), "REJECTED"),
 ("Radio edit, no duration known — variant tag alone caps at uncertain",
  T(title="Take on Me", artists=["a-ha"]),
  T(name="Take On Me - Radio Edit", artists=["a-ha"]), "UNCERTAIN"),
 ("Live on BOTH sides — set equality, not a blocklist",
  T(title="Hotel California - Live", artists=["Eagles"], duration_ms=428000),
  T(name="Hotel California (Live)", artists=["Eagles"], duration_ms=428000), "CONFIDENT"),
 ("Two different remixes of the same song",
  T(title="Praise You - Fatboy Slim Remix", artists=["Fatboy Slim"]),
  T(name="Praise You - Purple Disco Machine Remix", artists=["Fatboy Slim"]), "REJECTED"),
 ("Leading article on the candidate artist",
  T(title="Blinding Lights", artists=["Weeknd"], duration_ms=200000),
  T(name="Blinding Lights", artists=["The Weeknd"], duration_ms=200040), "CONFIDENT"),
 ("Collaborator missing from the candidate entirely",
  T(title="Under Pressure", artists=["Queen", "David Bowie"], duration_ms=248000),
  T(name="Under Pressure", artists=["Queen"], duration_ms=248000), "UNCERTAIN"),
 ("Same title+artist, different master, trusted duration",
  T(title="Purple Rain", artists=["Prince"], duration_ms=520000, duration_trusted=True),
  T(name="Purple Rain", artists=["Prince", "The Revolution"], duration_ms=245000), "REJECTED"),
 ("Re-recording (Taylor's Version)",
  T(title="All Too Well", artists=["Taylor Swift"], duration_ms=329000),
  T(name="All Too Well (Taylor's Version)", artists=["Taylor Swift"], duration_ms=329160), "REJECTED"),
 ("Singular vs plural is a real title difference",
  T(title="The Sound of Silence", artists=["Simon & Garfunkel"], duration_ms=185000),
  T(name="The Sounds of Silence", artists=["Simon & Garfunkel"], duration_ms=186000), "REJECTED"),
 ("Unknown soundtrack suffix — match, but never auto-add",
  T(title="Sunflower", artists=["Post Malone", "Swae Lee"], duration_ms=158000),
  T(name="Sunflower - Spider-Man: Into the Spider-Verse",
    artists=["Post Malone", "Swae Lee"], duration_ms=157560), "UNCERTAIN"),
 ("Clean vs explicit is a variant",
  T(title="HUMBLE.", artists=["Kendrick Lamar"], duration_ms=177000, explicit=True),
  T(name="HUMBLE. - Clean", artists=["Kendrick Lamar"], duration_ms=177000, explicit=False), "UNCERTAIN"),
 ("Different song, one shared token",
  T(title="Love", artists=["Lana Del Rey"]),
  T(name="Love Song", artists=["Lana Del Rey"]), "REJECTED"),
 ("Same recording, ISRC agrees, titles disagree cosmetically",
  T(title="Fake Plastic Trees", artists=["Radiohead"], isrc="GBAYE9500123"),
  T(name="Fake Plastic Trees - 2009 Remaster", artists=["Radiohead"], isrc="gbaye9500123"), "CONFIDENT"),
 ("Compilation re-release, same recording",
  T(title="Dreams", artists=["Fleetwood Mac"], duration_ms=257000, album="Rumours", year=1977),
  T(name="Dreams - 2004 Remaster", artists=["Fleetwood Mac"], duration_ms=257600,
    album="Rumours (Deluxe Edition)", year=2004), "CONFIDENT"),
]

def run():
    print("=== naive metrics on tricky pairs ===")
    metric_table()
    print("\n=== algorithm test suite ===")
    fails = 0
    for name, w, c, expect in CASES:
        r = verify(w, c)
        ok = r["verdict"] == expect
        fails += (not ok)
        print(f"[{'PASS' if ok else 'FAIL'}] {name}\n"
              f"        got={r['verdict']:<10} exp={expect:<10} score={r['score']:<6} {r['reasons']}")
    print(f"\n{len(CASES)-fails}/{len(CASES)} pass")

if __name__ == "__main__":
    run()
