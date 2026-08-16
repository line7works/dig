---
name: dig-setup
description: Walk a non-technical user through setting up Dig from scratch — Spotify Premium check, creating their own Spotify developer app, configuring the Client ID, adding themselves under User Management, and signing in. Use when the user wants to set up Dig, connect Spotify, asks why Dig's tools are missing or failing, or just installed the Dig plugin.
---

# Setting up Dig

You are walking a person who does not code through the ten minutes before Dig
works. Go one step at a time, wait for them to confirm each step, and never
ask them to open a terminal or edit a file. Dashboard URLs and button names
below were verified against the live Spotify dashboard on 2026-08-15 — use
them exactly; do not improvise instructions from memory.

If Dig's tools (dig_status, dig_connect, ...) are not available in this chat,
that is normal right after install or a config change: **plugin tools connect
when a chat starts, so the user must start a new chat.** Say so and stop.

## Step 0 — Premium check (ask first, stop on no)

Ask outright: "Do you have Spotify Premium? If not, stop here — Dig can't
work without it, and that's Spotify's rule, not ours."

Spotify requires the owner of a developer app to hold Premium for the app to
function at all, even just to read their own playlists. There is no
workaround. If they just subscribed, it can take a few hours before Spotify
lets their app through. If the answer is no, stop — do not walk them through
app creation only to fail at the end.

## Step 1 — Create the Spotify app (~2 minutes, free)

1. Go to **https://developer.spotify.com/dashboard** and log in with the
   Spotify account whose playlists Dig should manage.
2. Click the **Create app** button (top right of the Dashboard page).
3. App name and description can be anything — "Dig" is fine.

## Step 2 — Paste the redirect address, exactly

In the creation form's **Redirect URIs** box (or later: the app's **Basic
Information** page, scroll down to Redirect URIs), paste exactly:

```
http://127.0.0.1:8888/callback
```

then click **Add**, and **Save**. It must match character for character — no
slash at the end, `http` not `https`. If Spotify refuses the address, they
typed a variation; have them copy the line above again.

## Step 3 — Copy the Client ID into Claude (never the Secret)

The **Client ID** is at the top of the app's **Basic Information** page — 32
letters and numbers, with a copy button.

**Say this out loud: never paste your Client Secret.** The "View client
secret" link sits right underneath the Client ID and the value looks
identical. Dig never needs it, and it should never be pasted anywhere.

Ask the user to paste the Client ID **into the chat**. Then configure it
yourself by running:

```
claude plugin install dig@dig --config spotify_client_id=<the pasted ID>
```

Do not send the user to `/plugin` menus or settings screens. After the
command succeeds, tell them: **start a new chat** (config changes only reach
Dig's tools in a fresh chat), then come back to these steps there.

## Step 4 — Add yourself under User Management (LOUD, and slow)

**This is the step that breaks most people. Do not let them skip it.**

1. On the app's page, open the **User Management** tab (next to Basic
   Information).
2. Enter their name under **Full Name** and, under **Email**, **the email
   address on their Spotify account** — if they have several addresses, it
   has to be that one.
3. Click **Add user**.

Their own app can reject them until they do this, and the only symptom is a
permission error later that looks like something else entirely. **It can take
up to 15 minutes to take effect. Say that out loud — the wait is real, and
"it didn't work immediately" does not mean it failed.**

## Step 5 — Sign in through the browser

Call `dig_connect`. A normal Spotify approval screen opens in their browser;
they approve it with the same account. Then call `dig_status` to confirm who
connected — if it names the wrong account, have them sign out of Spotify in
the browser and run `dig_connect` again.

`dig_connect` also serves a local reference page with this whole picture and
the exact redirect address to copy — point them at it for the visual.

Finish with a real edit: list their playlists, or create a test playlist,
so they see it working.

## If anything fails

Run `dig_doctor`. It checks each layer in order and every failure comes back
with instructions. The most common first-run failure is a 403 meaning the
Step 4 self-add has not taken effect yet — wait the 15 minutes.

## Optional: enabling playlist deletion

The `dig_unfollow_playlist` tool (delete/unfollow a whole playlist) ships
**disabled** because for playlists you own, unfollowing IS deletion. Spotify
keeps deleted playlists recoverable for 90 days at spotify.com, but Dig
treats it as destructive. If the user explicitly wants it, warn them of
exactly that, then run:

```
claude plugin install dig@dig --config dig_enable_unfollow=true
```

(keeping their existing `spotify_client_id` config: pass both `--config`
flags if the install asks again). Then **start a new chat** — the tool
appears there. To turn it off, set `dig_enable_unfollow` to anything else.
