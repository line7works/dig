---
name: dig-setup
description: Walk a non-technical user through setting up Dig from scratch — Spotify Premium check, creating their own Spotify developer app, configuring the Client ID, adding themselves under User Management, and signing in. Use when the user wants to set up Dig, connect Spotify, asks why Dig's tools are missing or failing, or just installed the Dig plugin.
---

# Setting up Dig

You are walking a person who does not code through the ten minutes before Dig
works. Go one step at a time, wait for them to confirm each step, and never
ask them to open a terminal or edit a file. Dashboard URLs, button names, and
the form's field order below were verified against the live Spotify dashboard
on 2026-08-16 — use them exactly; do not improvise instructions from memory.

Start with this, in your own warm words: **Dig is something we built for
ourselves and like sharing.** Everything in this setup — the Spotify app they
create, the Client ID, the sign-in — lives on their own computer and talks
only to Spotify. Nothing is stored by, or visible to, Line 7 or anyone else.

If Dig's tools (dig_status, dig_connect, ...) are not available in this chat,
that is normal right after install: **plugin tools connect when a chat
starts, so the user must start a new chat.** Say so and stop. (If Dig isn't
installed at all, that's the install story in Dig's README — one pasted
sentence. The folder attached to the chat does not matter: Dig installs at
user level, works from every folder, and writes nothing into the folder.)

## Step 0 — Premium check (get the answer before anything else)

Ask outright: "Do you have Spotify Premium?" **Wait for the answer. Do not
continue to Step 1 until they have answered — never proceed "assuming yes."**

Spotify requires the owner of a developer app to hold Premium for the app to
function at all, even just to read their own playlists. There is no
workaround — that's Spotify's rule, not ours. If they just subscribed, it can
take a few hours before Spotify lets their app through. If the answer is no,
stop — do not walk them through app creation only to fail at the end.

## Step 1 — Create the Spotify app (~2 minutes, free)

1. Go to **https://developer.spotify.com/dashboard** and log in with the
   Spotify account whose playlists Dig should manage.
2. Click the **Create app** button (top right of the Dashboard page).
3. Fill the form **top to bottom, in this order** (it's one form; Save comes
   at the end):
   - **App name** — anything; "Dig" is fine.
   - **App description** — anything; "Dig" is fine.
   - **Website** — optional; leave it empty.
   - **Redirect URIs** — paste exactly:

     ```
     http://127.0.0.1:8888/callback
     ```

     then click **Add** (the address appears in a list with a Remove button).
     It must match character for character — no slash at the end, `http` not
     `https`. If Spotify refuses the address, they typed a variation; have
     them copy the line above again.
   - **Which API/SDKs are you planning to use?** — tick **Web API**.
   - Tick the checkbox agreeing to **Spotify's Developer Terms of Service
     and Design Guidelines**.
   - Click **Save** at the bottom of the form.

## Step 2 — Fixing the redirect address later (only if needed)

If the app already exists and the redirect address is missing or wrong: on
the app's **Basic Information** page, scroll down to **Redirect URIs**, paste
the exact address from Step 1, click **Add**, then **Save**.

## Step 3 — Copy the Client ID into the chat (never the Secret)

The **Client ID** is at the top of the app's **Basic Information** page — 32
letters and numbers, with a copy button.

**Say this out loud: never paste your Client Secret.** The "View client
secret" link sits right underneath the Client ID and the value looks
identical. Dig never needs it, and it should never be pasted anywhere.

Ask the user to paste the Client ID **right here into the chat**. Then store
it yourself by calling the **dig_set_client_id** tool with the pasted value.
It takes effect immediately — no restart, no new chat. (Starting a new chat
is only ever needed right after installing the plugin, never after setting
the Client ID.) Do not send the user to `/plugin` menus, settings screens,
or a terminal.

## Step 4 — Add yourself under User Management (LOUD, and slow)

**This is the step that breaks most people. Do not let them skip it.**

1. **Don't navigate away** — on the same page they copied the Client ID
   from, click the **User Management** tab (next to Basic Information).
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
they approve it with the same account. If no browser opens, the
`dig_connect` result includes the address to open by hand. Then call
`dig_status` to confirm who connected — if it names the wrong account, have
them sign out of Spotify in the browser and run `dig_connect` again.

`dig_connect` also serves a local reference page with this whole picture and
the exact redirect address to copy — its address is in the `dig_connect`
result; point them at it for the visual.

Finish with a real edit: list their playlists, or create a test playlist,
so they see it working.

## If anything fails

Run `dig_doctor`. It checks each layer in order and every failure comes back
with instructions — including which place the Client ID is coming from (the
plugin's settings or Dig's own config file). The most common first-run
failure is a 403 meaning the Step 4 self-add has not taken effect yet — wait
the 15 minutes. If sign-in itself fails strangely, double-check that the
configured value is the one labeled **Client ID** — a pasted Client Secret
has the same shape and no check can tell them apart.

## Optional: enabling playlist deletion

The `dig_unfollow_playlist` tool (delete/unfollow a whole playlist) ships
**disabled** because for playlists you own, unfollowing IS deletion. Spotify
keeps deleted playlists recoverable for 90 days at spotify.com, but Dig
treats it as destructive. If the user explicitly wants it, warn them of
exactly that, then call the **dig_enable_playlist_deletion** tool with
`enable: true` — it takes effect in this session (if the tool list doesn't
refresh, it appears in the next new chat). To turn it off, call the same
tool with `enable: false`.
