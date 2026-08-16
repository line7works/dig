# Dig

Dig lets you manage your own Spotify playlists by talking to Claude: create
playlists, rename them, add tracks that get verified against Spotify before
anything is written, reorder, find duplicates, and grow a playlist by feel —
you describe the mood, Claude proposes songs, Dig checks each one is real
before it lands. **Dig requires a Spotify Premium subscription.** That is
Spotify's rule for people who run their own Spotify app (which Dig has you
do), not ours — there is no free-tier path and no workaround. If you don't
have Premium, Dig cannot work for you.

Everything runs on your own computer and talks only to Spotify. Nothing you
do — your playlists, your account, your sign-in — is stored by or visible to
Line 7 or anyone else. Dig is something we built for ourselves and like
sharing.

## What you need

1. **A Mac with the Claude desktop app** — the Claude app installed on your
   computer, not the claude.ai website. Dig cannot run in a browser chat.
2. **A Claude subscription** that includes Claude Code (most paid plans do).
3. **Spotify Premium.**

## Install

Open the Claude desktop app and start a **Local** chat: click **Open
folder…** and pick any folder — it truly does not matter which. Dig installs
at the user level, works from every folder afterward, and writes nothing
into the folder you pick.

Then paste this one sentence into the chat, exactly as written:

```
Install the Dig plugin: run /plugin marketplace add line7works/dig and then /plugin install dig@dig, ignore any configuration prompts during install, and then remind me to start a new chat and say "set up Dig".
```

Two things to expect:

- The installer may mention unset configuration options. **Ignore that** —
  you'll configure Dig in chat, afterward.
- Plugin tools connect when a chat starts, so after installing you must
  **start a new chat** and say **"set up Dig"**. Claude then walks you
  through the rest: checking Premium, creating your own (free) Spotify app,
  pasting your Client ID into the chat, adding yourself under the app's
  User Management tab, and signing in through your browser. About ten
  minutes, no terminal, no file editing.

During setup you paste your Client ID directly into the chat — Dig stores it
for you. Never paste your Client **Secret** anywhere; Dig doesn't use one.

## Good to know

- **Your playlists only.** Dig works on playlists you own or collaborate on.
  Reading a friend's playlist or Spotify's editorial playlists (like
  Discover Weekly) is not possible for apps like this — Spotify's
  restriction, stated here so you're not surprised.
- **Reconnect twice a year.** Spotify expires the connection after six
  months, absolutely. Dig warns you at five months, and reconnecting is one
  step.
- **macOS is what's tested.** The code avoids Mac-only tricks, but macOS is
  the only platform we've verified end to end.
- **Desktop and terminal are separate.** If you use Dig in the Claude
  desktop app and also in a terminal, each keeps its own configuration and
  sign-in — set up once per surface. Most people only ever use one.

## Updates

Claude Code does **not** auto-update plugins from community marketplaces, so
updates are manual: in a chat, run `/plugin marketplace update dig` and then
`/plugin update dig@dig`, and start a new chat afterward.

## Uninstalling

Heads up: **uninstalling Dig can delete everything it stores locally** —
your snapshots (the backups Dig saves before any destructive change), your
Spotify sign-in, and your saved Client ID. Your actual Spotify playlists
are untouched, but a reinstall means setting up again.

## License

[MIT](LICENSE).

---

**Dig — a Line 7 product.**
