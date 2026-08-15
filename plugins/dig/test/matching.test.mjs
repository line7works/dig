// Slice D — matching engine. All 31 cases ported from
// docs/dig-matching-reference.py (the annotated reference); names kept
// verbatim so the named regression cases (AC2) are assertable by name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { verify, verifyCandidates } from "../server/matching.mjs";

const CASES = [
  ["Sweetgrass vs Grass (the live bug)",
    { title: "Sweetgrass", artists: ["Kaitlyn Aurelia Smith"] },
    { name: "Grass", artists: ["Kaitlyn Aurelia Smith"] }, "REJECTED"],
  ["Grass vs Sweetgrass (reverse containment)",
    { title: "Grass", artists: ["Animal Collective"] },
    { name: "Sweetgrass", artists: ["Animal Collective"] }, "REJECTED"],
  ["Two-token containment: Alive vs Stayin' Alive",
    { title: "Alive", artists: ["Pearl Jam"] },
    { name: "Stayin' Alive", artists: ["Pearl Jam"] }, "REJECTED"],
  ["Remaster suffix, Spotify dash form",
    { title: "Bohemian Rhapsody", artists: ["Queen"], duration_ms: 354000 },
    { name: "Bohemian Rhapsody - Remastered 2011", artists: ["Queen"], duration_ms: 354320 }, "CONFIDENT"],
  ["Remaster suffix, parenthetical form",
    { title: "In the Air Tonight", artists: ["Phil Collins"], duration_ms: 336000 },
    { name: "In the Air Tonight (2015 Remastered)", artists: ["Phil Collins"], duration_ms: 335000 }, "CONFIDENT"],
  ["Live version is a different recording",
    { title: "Hotel California", artists: ["Eagles"], duration_ms: 391000 },
    { name: "Hotel California - Live", artists: ["Eagles"], duration_ms: 428000 }, "REJECTED"],
  ["Acoustic version",
    { title: "Everlong", artists: ["Foo Fighters"] },
    { name: "Everlong - Acoustic Version", artists: ["Foo Fighters"] }, "REJECTED"],
  ["Remix",
    { title: "Blinding Lights", artists: ["The Weeknd"] },
    { name: "Blinding Lights (Chromatics Remix)", artists: ["The Weeknd"] }, "REJECTED"],
  ["Cover by a different artist",
    { title: "Hurt", artists: ["Nine Inch Nails"], duration_ms: 373000 },
    { name: "Hurt", artists: ["Johnny Cash"], duration_ms: 218000 }, "REJECTED"],
  ["Cover, near-identical duration (artist gate must carry it)",
    { title: "Africa", artists: ["Toto"], duration_ms: 295000 },
    { name: "Africa", artists: ["Weezer"], duration_ms: 272000 }, "REJECTED"],
  ["Karaoke soundalike",
    { title: "Wonderwall", artists: ["Oasis"] },
    { name: "Wonderwall (Originally Performed by Oasis) [Karaoke Version]",
      artists: ["Ameritz Karaoke Standards"] }, "REJECTED"],
  ["feat. in candidate title, artist in wanted field",
    { title: "Goosebumps", artists: ["Travis Scott", "Kendrick Lamar"], duration_ms: 243000 },
    { name: "goosebumps (feat. Kendrick Lamar)", artists: ["Travis Scott"], duration_ms: 243837 }, "CONFIDENT"],
  ["feat. in wanted title, artist in candidate field",
    { title: "Where Is the Love? (feat. Justin Timberlake)", artists: ["Black Eyed Peas"], duration_ms: 270000 },
    { name: "Where Is The Love?", artists: ["Black Eyed Peas", "Justin Timberlake"], duration_ms: 272000 }, "CONFIDENT"],
  ["Accents + ampersand + article",
    { title: "Déjà Vu", artists: ["Beyoncé & Jay-Z"], duration_ms: 242000 },
    { name: "Deja Vu", artists: ["Beyonce", "JAY-Z"], duration_ms: 242000 }, "CONFIDENT"],
  ["Curly vs straight apostrophe, case",
    { title: "Don’t Stop Me Now", artists: ["Queen"], duration_ms: 209000 },
    { name: "DON'T STOP ME NOW", artists: ["Queen"], duration_ms: 209413 }, "CONFIDENT"],
  ["Leading 'The' in artist only",
    { title: "Take Five", artists: ["Dave Brubeck Quartet"], duration_ms: 324000 },
    { name: "Take Five", artists: ["The Dave Brubeck Quartet"], duration_ms: 324000 }, "CONFIDENT"],
  ["Punctuation-only title difference",
    { title: "Hey Ya!", artists: ["OutKast"], duration_ms: 235000 },
    { name: "Hey Ya", artists: ["Outkast"], duration_ms: 235213 }, "CONFIDENT"],
  ["Radio edit, 2 minutes shorter — duration confirms it is a different cut",
    { title: "One More Time", artists: ["Daft Punk"], duration_ms: 320000 },
    { name: "One More Time - Radio Edit", artists: ["Daft Punk"], duration_ms: 200000 }, "REJECTED"],
  ["Radio edit, no duration known — variant tag alone caps at uncertain",
    { title: "Take on Me", artists: ["a-ha"] },
    { name: "Take On Me - Radio Edit", artists: ["a-ha"] }, "UNCERTAIN"],
  ["Live on BOTH sides — set equality, not a blocklist",
    { title: "Hotel California - Live", artists: ["Eagles"], duration_ms: 428000 },
    { name: "Hotel California (Live)", artists: ["Eagles"], duration_ms: 428000 }, "CONFIDENT"],
  ["Two different remixes of the same song",
    { title: "Praise You - Fatboy Slim Remix", artists: ["Fatboy Slim"] },
    { name: "Praise You - Purple Disco Machine Remix", artists: ["Fatboy Slim"] }, "REJECTED"],
  ["Leading article on the candidate artist",
    { title: "Blinding Lights", artists: ["Weeknd"], duration_ms: 200000 },
    { name: "Blinding Lights", artists: ["The Weeknd"], duration_ms: 200040 }, "CONFIDENT"],
  ["Collaborator missing from the candidate entirely",
    { title: "Under Pressure", artists: ["Queen", "David Bowie"], duration_ms: 248000 },
    { name: "Under Pressure", artists: ["Queen"], duration_ms: 248000 }, "UNCERTAIN"],
  ["Same title+artist, different master, trusted duration",
    { title: "Purple Rain", artists: ["Prince"], duration_ms: 520000, duration_trusted: true },
    { name: "Purple Rain", artists: ["Prince", "The Revolution"], duration_ms: 245000 }, "REJECTED"],
  ["Re-recording (Taylor's Version)",
    { title: "All Too Well", artists: ["Taylor Swift"], duration_ms: 329000 },
    { name: "All Too Well (Taylor's Version)", artists: ["Taylor Swift"], duration_ms: 329160 }, "REJECTED"],
  ["Singular vs plural is a real title difference",
    { title: "The Sound of Silence", artists: ["Simon & Garfunkel"], duration_ms: 185000 },
    { name: "The Sounds of Silence", artists: ["Simon & Garfunkel"], duration_ms: 186000 }, "REJECTED"],
  ["Unknown soundtrack suffix — match, but never auto-add",
    { title: "Sunflower", artists: ["Post Malone", "Swae Lee"], duration_ms: 158000 },
    { name: "Sunflower - Spider-Man: Into the Spider-Verse",
      artists: ["Post Malone", "Swae Lee"], duration_ms: 157560 }, "UNCERTAIN"],
  ["Clean vs explicit is a variant",
    { title: "HUMBLE.", artists: ["Kendrick Lamar"], duration_ms: 177000, explicit: true },
    { name: "HUMBLE. - Clean", artists: ["Kendrick Lamar"], duration_ms: 177000, explicit: false }, "UNCERTAIN"],
  ["Different song, one shared token",
    { title: "Love", artists: ["Lana Del Rey"] },
    { name: "Love Song", artists: ["Lana Del Rey"] }, "REJECTED"],
  ["Same recording, ISRC agrees, titles disagree cosmetically",
    { title: "Fake Plastic Trees", artists: ["Radiohead"], isrc: "GBAYE9500123" },
    { name: "Fake Plastic Trees - 2009 Remaster", artists: ["Radiohead"], isrc: "gbaye9500123" }, "CONFIDENT"],
  ["Compilation re-release, same recording",
    { title: "Dreams", artists: ["Fleetwood Mac"], duration_ms: 257000, album: "Rumours", year: 1977 },
    { name: "Dreams - 2004 Remaster", artists: ["Fleetwood Mac"], duration_ms: 257600,
      album: "Rumours (Deluxe Edition)", year: 2004 }, "CONFIDENT"],
];

test("reference suite has all 31 cases", () => {
  assert.equal(CASES.length, 31);
});

for (const [name, wanted, cand, expect] of CASES) {
  test(`matching: ${name}`, () => {
    const r = verify(wanted, cand);
    assert.equal(r.verdict, expect, `score=${r.score} reasons=${JSON.stringify(r.reasons)}`);
  });
}

// AC2 — the named regression cases must be present in the suite by name.
test("AC2 named regression cases are present", () => {
  const names = CASES.map(([n]) => n);
  const required = [
    "Sweetgrass vs Grass (the live bug)",
    "Same title+artist, different master, trusted duration", // Purple Rain album-vs-single by duration
    "Singular vs plural is a real title difference",         // Sound/Sounds of Silence
    "Cover by a different artist",                           // NIN/Cash "Hurt" by artist
    "Live on BOTH sides — set equality, not a blocklist",    // requested live version accepted
  ];
  for (const r of required) assert.ok(names.includes(r), `missing named case: ${r}`);
});

// Regression — norm()'s leading-track-number strip must be Unicode-aware like
// Python's \w (JS \w is ASCII-only; the un-stripped prefix wrongly rejected
// CJK titles the reference matches as CONFIDENT).
test("track-number strip works before non-ASCII titles", () => {
  const r = verify(
    { title: "東京", artists: ["サカナクション"] },
    { name: "07 東京", artists: ["サカナクション"] },
  );
  assert.equal(r.verdict, "CONFIDENT", `score=${r.score} reasons=${JSON.stringify(r.reasons)}`);
});

// R4 — structured evidence: per-gate outcomes, score, alternatives.
test("R4 verdicts carry structured evidence", () => {
  const rejected = verify(
    { title: "Everlong", artists: ["Foo Fighters"] },
    { name: "Everlong - Acoustic Version", artists: ["Foo Fighters"] },
  );
  assert.equal(rejected.verdict, "REJECTED");
  assert.ok(rejected.reasons.some((r) => r.startsWith("version-class-mismatch")));
  assert.equal(typeof rejected.score, "number");

  const uncertain = verify(
    { title: "Under Pressure", artists: ["Queen", "David Bowie"] },
    { name: "Under Pressure", artists: ["Queen"] },
  );
  assert.equal(uncertain.verdict, "UNCERTAIN");
  assert.ok(uncertain.reasons.some((r) => r.startsWith("artist-coverage")));
});

test("R4 verifyCandidates ranks best and returns alternatives with evidence", () => {
  const wanted = { title: "Hotel California", artists: ["Eagles"], duration_ms: 391000 };
  const { best, alternatives } = verifyCandidates(wanted, [
    { name: "Hotel California - Live", artists: ["Eagles"], duration_ms: 428000 },
    { name: "Hotel California", artists: ["Eagles"], duration_ms: 391000 },
  ]);
  assert.equal(best.candidate.name, "Hotel California");
  assert.equal(best.verdict, "CONFIDENT");
  assert.equal(alternatives.length, 1);
  assert.equal(alternatives[0].verdict, "REJECTED");
  assert.ok(Array.isArray(alternatives[0].reasons));

  assert.equal(verifyCandidates(wanted, []).best, null);
});
