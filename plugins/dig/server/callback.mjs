// Loopback callback server + the read-only setup reference page (research §9
// CVE-2025-66040 mitigations): bind 127.0.0.1 explicitly, validate the Host
// header, escape everything reflected, fully self-contained HTML, 404 every
// unknown path, validate state, handle Deny cleanly, shut down after the one
// callback, hard timeout on the listener.
import { createServer } from "node:http";
import { log } from "./log.mjs";

// Spotify's dashboard (2025 rules) rejects portless loopback URIs, so the
// callback listener is pinned to a fixed port and the registered URI carries
// it explicitly. Override with DIG_CALLBACK_PORT if 8888 is taken.
export const CALLBACK_PORT = process.env.DIG_CALLBACK_PORT !== undefined
  ? Number(process.env.DIG_CALLBACK_PORT) // 0 = ephemeral, used by the tests
  : 8888;
export const REGISTERED_REDIRECT_URI = `http://127.0.0.1:${CALLBACK_PORT}/callback`;

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function page(title, body) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>
  body{font-family:-apple-system,system-ui,sans-serif;max-width:640px;margin:3rem auto;padding:0 1rem;line-height:1.5;color:#1a1a1a;background:#fafafa}
  code{background:#eee;padding:.15em .4em;border-radius:4px;font-size:.95em}
  .card{background:#fff;border:1px solid #ddd;border-radius:8px;padding:1.5rem}
  footer{margin-top:2rem;color:#888;font-size:.85em}
  ol li{margin:.5em 0}
</style></head>
<body><div class="card">${body}</div>
<footer>Dig — a Line 7 product</footer></body></html>`;
}

export function referencePage() {
  // The whole setup picture at once, read-only, captures nothing (PRD §9).
  return page("Dig setup — Spotify app", `
<h1>Setting up Dig</h1>
<p>Dig is something we built for ourselves and like sharing. Everything here — the Spotify app you create, your Client ID, the sign-in — stays on your own computer and talks only to Spotify. Nothing is stored by, or visible to, Line 7 or anyone else.</p>
<p>Dig needs a free Spotify developer app that belongs to you. The whole thing takes about ten minutes. <strong>You need Spotify Premium</strong> — Spotify requires it for developer apps, and there is no workaround.</p>
<ol>
<li><strong>Create the app.</strong> Go to <a href="https://developer.spotify.com/dashboard" rel="noreferrer">developer.spotify.com/dashboard</a>, sign in with your Spotify account, and click <strong>Create app</strong>. Fill the form top to bottom: <strong>App name</strong> and <strong>App description</strong> can be anything (e.g. "Dig"); <strong>Website</strong> is optional. In <strong>Redirect URIs</strong>, put exactly:<br>
<code>${escapeHtml(REGISTERED_REDIRECT_URI)}</code><br>
then click <strong>Add</strong>. Character for character — no slash at the end, <code>http</code> not <code>https</code>. Then tick <strong>Web API</strong> under "Which API/SDKs are you planning to use?", tick the checkbox agreeing to Spotify's Developer Terms, and click <strong>Save</strong> at the bottom.</li>
<li><strong>Copy the Client ID.</strong> It is at the top of your app's <strong>Basic Information</strong> page, with a copy button. Paste it into the Claude chat — Dig stores it for you and it works immediately. <strong>Never paste your Client Secret</strong> — the "View client secret" link sits right underneath and the value looks identical. Dig never needs it.</li>
<li><strong>Add yourself under User Management.</strong> Don't navigate away — on the same page, open the <strong>User Management</strong> tab (next to Basic Information), enter your name and <em>the email address on your Spotify account</em>, and click <strong>Add user</strong>. Your own app can reject you until you do this, and it can take <strong>up to 15 minutes</strong> to take effect. That wait is real — it will not work immediately.</li>
<li><strong>Sign in.</strong> Back in Claude, ask Dig to connect. Your browser opens a normal Spotify approval screen.</li>
</ol>
<p>This page is served by Dig on your own computer. It is read-only and collects nothing.</p>`);
}

// Runs the one-shot callback listener. Resolves { code } on success, rejects
// on deny/timeout/state-mismatch. onDone(server) fires after the callback
// response is flushed. renderResult(params) lets the caller decide the HTML
// for the success page (so the exchange can happen inline and the page can
// show the connected account, per R6).
export function startCallbackServer({ state, timeoutMs = 5 * 60 * 1000, renderResult }) {
  return new Promise((resolveStart, rejectStart) => {
    let settled = false;
    let settle;
    const done = new Promise((resolve, reject) => {
      settle = (err, val) => {
        if (settled) return;
        settled = true;
        err ? reject(err) : resolve(val);
      };
    });

    const server = createServer(async (req, res) => {
      const host = req.headers.host ?? "";
      const port = server.address().port;
      if (host !== `127.0.0.1:${port}`) {
        // DNS-rebinding defense: only the literal loopback host is served.
        res.writeHead(403, { "Content-Type": "text/plain" }).end("Forbidden");
        return;
      }
      const url = new URL(req.url, `http://127.0.0.1:${port}`);
      if (url.pathname === "/" || url.pathname === "/setup") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" }).end(referencePage());
        return;
      }
      if (url.pathname !== "/callback") {
        res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
        return;
      }
      // The callback. Exactly one is honored; the listener closes after it.
      const gotState = url.searchParams.get("state");
      const err = url.searchParams.get("error");
      const code = url.searchParams.get("code");
      let html;
      let outcome = null;
      if (gotState !== state) {
        html = page("Dig — sign-in problem", `<h1>That sign-in link didn't match.</h1><p>For safety, Dig only accepts the exact sign-in it started. Go back to Claude and ask Dig to connect again.</p>`);
        outcome = new Error("state mismatch on callback");
      } else if (err) {
        html = page("Dig — not connected", `<h1>No problem — nothing was connected.</h1><p>You clicked <strong>${escapeHtml(err === "access_denied" ? "Cancel" : err)}</strong> on Spotify's screen, so Dig has no access to your account. If you change your mind, ask Dig to connect again.</p>`);
        outcome = new Error("user denied authorization");
      } else if (!code) {
        html = page("Dig — sign-in problem", `<h1>Spotify didn't send a sign-in code.</h1><p>Go back to Claude and ask Dig to connect again.</p>`);
        outcome = new Error("callback missing code");
      } else if (renderResult) {
        // Success path: the caller exchanges the code now and hands back the
        // page to show (connected-as name, or a mapped error).
        try {
          html = await renderResult({ code, page });
        } catch (e) {
          html = page("Dig — sign-in problem", `<h1>Something went wrong finishing sign-in.</h1><p>${escapeHtml(e?.publicMessage ?? "Go back to Claude and ask Dig to connect again.")}</p>`);
          outcome = e;
        }
      } else {
        html = page("Dig — connected", `<h1>Connected.</h1><p>You can close this tab and go back to Claude.</p>`);
      }
      res.writeHead(outcome && !code ? 400 : 200, { "Content-Type": "text/html; charset=utf-8" }).end(html, () => {
        server.close();
        settle(outcome, outcome ? undefined : { code });
      });
    });

    const timer = setTimeout(() => {
      server.close();
      settle(new Error("sign-in timed out — no callback within the time limit"));
    }, timeoutMs);
    timer.unref();

    // Deny/mismatch reject the flow the instant the callback lands, often
    // before the caller has awaited `done`; the guard keeps that early
    // rejection from counting as unhandled while callers still observe it.
    const exposedDone = done.finally(() => clearTimeout(timer));
    exposedDone.catch(() => {});

    server.on("error", (e) => {
      clearTimeout(timer);
      const err = e.code === "EADDRINUSE"
        ? new Error(`port ${CALLBACK_PORT} is already in use — set DIG_CALLBACK_PORT to a free port and register that redirect URI on the Spotify dashboard`)
        : e;
      settle(err);
      rejectStart(err);
    });
    server.listen(CALLBACK_PORT, "127.0.0.1", () => {
      const port = server.address().port;
      log(`callback server on 127.0.0.1:${port}`);
      resolveStart({
        port,
        redirectUri: `http://127.0.0.1:${port}/callback`,
        referenceUrl: `http://127.0.0.1:${port}/setup`,
        done: exposedDone,
        close: () => { clearTimeout(timer); server.close(); settle(new Error("cancelled")); },
      });
    });
  });
}
