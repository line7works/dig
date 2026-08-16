// dig_doctor (slice G R4, PRD §10): a self-check that runs every setup layer
// in order — Client ID shape, stored connection and its age, one live probe —
// and maps each failure to its plain-language instruction. The diagnosis is
// the successful result of a doctor run, so failures come back isError:false
// with the checklist; the mapped copy rides inside it.
import { defineTool } from "./tool-def.mjs";
import { checkClientId } from "./config.mjs";
import {
  readTokenFile, tokenAge, ageWarning, AuthExpiredError,
} from "./token-store.mjs";
import { RateLimitError, SpotifyApiError } from "./error-map.mjs";
import { spotify, waitBudget } from "./spotify-client.mjs";
import { activeSignIn } from "./auth.mjs";
import { REGISTERED_REDIRECT_URI } from "./callback.mjs";

export const DOCTOR_TOOL = defineTool({
  name: "dig_doctor",
  title: "Dig self-check",
  access: "read",
  description:
    "Run Dig's self-check: verifies the Spotify Client ID, the stored connection and its age, and makes one live Spotify call. Each failure comes back with plain-language instructions for fixing it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});

const OK = (label) => `✓ ${label}`;
const BAD = (label) => `✗ ${label}`;

// Sign-in that never completes is the redirect-mismatch signature: Spotify
// shows its own error page and the callback never fires, so from Dig's side
// the flow just times out. There is no runtime trigger for the "redirect
// address rejected" copy — the dashboard rejects it, not Dig — so the doctor
// surfaces the exact-URI fix on this symptom instead.
const REDIRECT_HINT = `If the browser sign-in showed a Spotify error page (or nothing happened), the usual cause is the redirect address. Your app's **Redirect URIs** box must contain exactly:

\`${REGISTERED_REDIRECT_URI}\`

Character for character — no slash at the end, \`http\` not \`https\`. Fix it on the app's page at developer.spotify.com/dashboard, then run dig_connect again.`;

export function createDoctorTool({ client = spotify, deps = {} } = {}) {
  const {
    check = checkClientId,
    readToken = readTokenFile,
    signIn = activeSignIn,
  } = deps;

  async function digDoctor() {
    const lines = ["Dig self-check:", ""];

    // 1. Client ID
    const id = check();
    if (id.state !== "ok") {
      lines.push(BAD(id.state === "invalid" ? "Client ID: configured but the wrong shape." : "Client ID: not configured."));
      lines.push("", id.message);
      lines.push("", "The remaining checks need a Client ID, so the doctor stopped here.");
      return { text: lines.join("\n"), isError: false };
    }
    lines.push(OK("Client ID: configured and looks valid (32 characters)."));

    // 2. Stored connection
    const record = readToken();
    if (!record?.refresh_token) {
      lines.push(BAD("Spotify connection: no sign-in stored."));
      const flow = signIn();
      if (flow?.result && !flow.result.ok) {
        lines.push("", `The last sign-in attempt did not finish:`, "", flow.result.message);
      }
      lines.push("", "Run dig_connect to sign in through the browser.", "", REDIRECT_HINT);
      return { text: lines.join("\n"), isError: false };
    }
    const days = Math.floor((tokenAge(record) ?? 0) / 86_400_000);
    const who = record.display_name ? ` as ${record.display_name}` : "";
    lines.push(OK(`Spotify connection: signed in${who}, ${days === 0 ? "connected today" : `${days} days old`}.`));
    const warn = ageWarning(record);
    if (warn) lines.push(`  ⚠ ${warn}`);

    // 3. One live probe through the serialized queue
    try {
      const me = await client.request("/me", { budget: waitBudget() });
      const name = me?.display_name || me?.id || "your account";
      lines.push(OK(`Live Spotify call: succeeded (connected account: ${name}).`));
      lines.push("", "Everything checks out — Dig is ready to use.");
    } catch (err) {
      if (err instanceof AuthExpiredError) {
        lines.push(BAD("Live Spotify call: the stored connection is no longer accepted."));
        lines.push("", err.message);
      } else if (err instanceof RateLimitError || err instanceof SpotifyApiError) {
        // The mapped copy already names the cause (Premium, allowlist, rate
        // limit, ...) and the next action.
        lines.push(BAD("Live Spotify call: failed."));
        lines.push("", err.message);
      } else {
        lines.push(BAD(`Live Spotify call: failed unexpectedly (${err?.message ?? err}).`));
        lines.push("", "This isn't one of the known Spotify failures. Check the network connection and try again; if it keeps happening, reconnect with dig_connect.");
      }
    }
    return { text: lines.join("\n"), isError: false };
  }

  return [{ def: DOCTOR_TOOL, handler: digDoctor }];
}
