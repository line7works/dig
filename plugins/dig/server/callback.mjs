// Loopback callback server + the read-only setup reference page (research §9
// CVE-2025-66040 mitigations): bind 127.0.0.1 explicitly, validate the Host
// header, escape everything reflected, fully self-contained HTML, 404 every
// unknown path, validate state, handle Deny cleanly, shut down after the one
// callback, hard timeout on the listener.
import { createServer } from "node:http";
import { log } from "./log.mjs";

// The portless loopback literal registered on the Spotify dashboard; the
// live redirect URI appends the port chosen free at auth time.
export const REGISTERED_REDIRECT_URI = "http://127.0.0.1/callback";

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
<p>Dig needs a free Spotify developer app that belongs to you. The whole thing takes about ten minutes. <strong>You need Spotify Premium</strong> — Spotify requires it for developer apps, and there is no workaround.</p>
<ol>
<li><strong>Create the app.</strong> Go to <a href="https://developer.spotify.com/dashboard" rel="noreferrer">developer.spotify.com/dashboard</a>, sign in with your Spotify account, and click <strong>Create app</strong>. Name and description can be anything (e.g. "Dig").</li>
<li><strong>Paste the redirect address.</strong> In the app form (or later under <strong>Settings</strong>), put exactly this into <strong>Redirect URIs</strong>, then click <strong>Add</strong> and <strong>Save</strong>:<br>
<code>${escapeHtml(REGISTERED_REDIRECT_URI)}</code><br>
Character for character — no slash at the end, <code>http</code> not <code>https</code>.</li>
<li><strong>Copy the Client ID</strong> from the app's <strong>Settings</strong> page into Claude when Dig asks. <strong>Never paste your Client Secret</strong> — it sits right underneath and looks identical. Dig never needs it.</li>
<li><strong>Add yourself under User Management.</strong> Settings → <strong>User Management</strong> tab → add your name and <em>the email address on your Spotify account</em>. Your own app rejects you until you do this, and it can take <strong>up to 15 minutes</strong> to take effect. That wait is real — it will not work immediately.</li>
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
  return new Promise((resolveStart) => {
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

    server.listen(0, "127.0.0.1", () => {
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
