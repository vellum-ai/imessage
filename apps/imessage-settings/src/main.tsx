/**
 * iMessage settings app.
 *
 * A compiled React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/imessage/`.
 *
 * One job: get the channel onto a provider that can actually send. That means
 * picking the provider (a POST to its own route, because the switch tears down
 * and restarts ingress server-side) and filling in the credentials that
 * provider needs, which is the step that was previously only possible from a
 * terminal.
 *
 * What it deliberately does not show is a status readout of the resolved
 * config — ingress mode, poll interval, allowed handles. None of it was
 * actionable from here, and a panel of numbers nobody can change reads as
 * important when it is not.
 *
 * Requests go through `api.ts`, which reaches the routes over the host bridge
 * — never the global `fetch`, which cannot escape the sandbox.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiRequest, messageOf } from "./api.ts";

const BASE = "/x/plugins/imessage";

const PROVIDER_LABELS: Record<string, string> = {
  comms: "Comms by Osis",
  photon: "Photon",
};

const PROVIDER_HINTS: Record<string, string> = {
  comms: "Your own Comms workspace and line, reached with one API key.",
  photon:
    "Your own Photon project. The project ID and secret mint the token its line is reached with.",
};

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .app { max-width: 720px; margin: 0 auto; padding: 24px 20px 64px; }
  h1 { font-size: 22px; margin: 0 0 4px; }
  h2 { font-size: 16px; margin: 28px 0 12px; }
  .sub { opacity: 0.7; margin: 0 0 20px; }
  .providers { display: grid; gap: 10px; }
  .provider {
    display: flex; align-items: flex-start; gap: 10px; padding: 12px;
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 8px; cursor: pointer; text-align: left; width: 100%;
    background: transparent; color: inherit; font: inherit;
  }
  .provider[aria-pressed="true"] {
    border-color: AccentColor;
    background: color-mix(in srgb, AccentColor 8%, transparent);
  }
  .provider:disabled { opacity: 0.6; cursor: default; }
  .provider .name { font-weight: 600; }
  .provider .hint { opacity: 0.7; font-size: 13px; }
  .creds {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 10px; padding: 16px; margin-top: 16px;
  }
  .field { display: grid; gap: 4px; margin-bottom: 14px; }
  .field label { font-weight: 600; font-size: 14px; }
  .field .hint { opacity: 0.7; font-size: 13px; }
  .field input {
    font: inherit; padding: 8px 10px; border-radius: 6px;
    border: 1px solid color-mix(in srgb, CanvasText 25%, transparent);
    background: Canvas; color: CanvasText;
  }
  .state { font-size: 12px; opacity: 0.75; }
  .state.set { color: color-mix(in srgb, CanvasText 55%, AccentColor); }
  button.save {
    font: inherit; font-weight: 600; padding: 8px 14px; border-radius: 6px;
    border: 1px solid AccentColor; cursor: pointer;
    background: color-mix(in srgb, AccentColor 12%, transparent);
    color: inherit;
  }
  button.save:disabled { opacity: 0.5; cursor: default; }
  .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 14px; }
  .banner.warn { background: color-mix(in srgb, Mark 40%, transparent); }
  .banner.err { background: color-mix(in srgb, LinkText 12%, transparent); }
  .banner.info { background: color-mix(in srgb, CanvasText 8%, transparent); }
`;

/** One credential a provider needs, and whether the store already has it. */
interface CredentialField {
  field: string;
  label: string;
  hint: string;
  secret: boolean;
  set: boolean;
}

type Credentials = Record<string, CredentialField[]>;

/** What `startChannelRuntime` did, as the routes report it. */
type ChannelStatus = "running" | "idle" | "not-loaded";

interface Settings {
  config: {
    provider: string;
    ingressMode: string;
    pollIntervalMs: number;
    sendChannel?: string;
    allowedHandles: string[];
  };
  editableKeys: string[];
  providers: string[];
  activeProvider: string | null;
  credentials: Credentials;
}

interface ChannelResult {
  activeProvider?: string | null;
  status?: ChannelStatus | null;
  idleReason?: string | null;
  credentials?: Credentials;
}

interface ProviderChange extends ChannelResult {
  config: Settings["config"];
}

/** A banner: what happened, and how alarmed to be about it. */
interface Notice {
  tone: "info" | "warn";
  text: string;
}

function labelFor(provider: string): string {
  return PROVIDER_LABELS[provider] ?? provider;
}

/**
 * Turn a channel result into something worth reading.
 *
 * `not-loaded` is the case that used to surface as "Channel is idle: plugin is
 * not initialized" — which sounded like a breakage when it only meant the
 * route could not reach a running channel in its own process. The write
 * happened; it applies on the next load. Say that.
 */
function noticeFor(
  result: ChannelResult,
  provider: string,
  what: string,
): Notice | null {
  switch (result.status) {
    case "running":
      return { tone: "info", text: `${what} ${labelFor(provider)} is running.` };
    case "idle":
      return {
        tone: "warn",
        text: `${what} ${labelFor(provider)} is not running: ${
          result.idleReason ?? "no reason given"
        }`,
      };
    case "not-loaded":
      return {
        tone: "info",
        text: `${what} It takes effect the next time the assistant loads this plugin.`,
      };
    default:
      return { tone: "info", text: what };
  }
}

function App(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<Settings>(
        "Loading settings",
        `${BASE}/settings`,
      );
      setSettings(next);
      // Follow the configured provider unless something is already selected:
      // a reload must not silently move the panel off what the user is
      // looking at.
      setSelected((current) => current ?? next.config.provider);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const switchProvider = useCallback(
    async (provider: string) => {
      setSelected(provider);
      setDrafts({});
      if (settings?.config.provider === provider) return;

      setBusy(true);
      setError(null);
      try {
        const result = await apiRequest<ProviderChange>(
          `Switching to ${labelFor(provider)}`,
          `${BASE}/provider`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider }),
          },
        );
        setNotice(noticeFor(result, provider, `Switched to ${labelFor(provider)}.`));
        await load();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [load, settings],
  );

  const saveCredentials = useCallback(
    async (provider: string, values: Record<string, string>) => {
      setBusy(true);
      setError(null);
      try {
        const result = await apiRequest<ChannelResult>(
          "Saving credentials",
          `${BASE}/credentials`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider, values }),
          },
        );
        setDrafts({});
        setNotice(noticeFor(result, provider, "Saved."));
        await load();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  const fields: CredentialField[] = useMemo(
    () => (selected ? (settings?.credentials?.[selected] ?? []) : []),
    [settings, selected],
  );

  if (error && !settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <div className="banner err">{error}</div>
      </div>
    );
  }

  if (!settings || !selected) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <p className="sub">Loading…</p>
      </div>
    );
  }

  // Only fields belonging to the provider on screen, so a draft left over from
  // another provider can never ride along with a save.
  const pending: Array<[string, string]> = fields
    .map((spec): [string, string] => [spec.field, drafts[spec.field] ?? ""])
    .filter(([, value]) => value.trim().length > 0);

  return (
    <div className="app">
      <style>{STYLES}</style>
      <h1>iMessage</h1>
      <p className="sub">
        People reach the assistant by texting a line it listens on.
      </p>

      {error ? <div className="banner err">{error}</div> : null}
      {notice ? (
        <div className={`banner ${notice.tone}`}>{notice.text}</div>
      ) : null}

      <h2>Provider</h2>
      <div className="providers">
        {settings.providers.map((id) => (
          <button
            key={id}
            type="button"
            className="provider"
            aria-pressed={selected === id}
            disabled={busy}
            onClick={() => void switchProvider(id)}
          >
            <div>
              <div className="name">
                {labelFor(id)}
                {settings.config.provider === id ? " — configured" : ""}
              </div>
              <div className="hint">{PROVIDER_HINTS[id] ?? ""}</div>
            </div>
          </button>
        ))}
      </div>

      <div className="creds">
        <h2 style={{ marginTop: 0 }}>{labelFor(selected)} credentials</h2>
        {fields.length === 0 ? (
          <p className="sub">This provider needs no credentials.</p>
        ) : null}

        {fields.map((spec) => (
          <div className="field" key={spec.field}>
            <label htmlFor={spec.field}>{spec.label}</label>
            <div className="hint">{spec.hint}</div>
            <input
              id={spec.field}
              // A stored secret is never sent back to the app, so the input
              // starts empty whether or not one exists. The placeholder is
              // what tells the two apart.
              type={spec.secret ? "password" : "text"}
              autoComplete="off"
              spellCheck={false}
              placeholder={spec.set ? "•••••••• (stored)" : "Not set"}
              value={drafts[spec.field] ?? ""}
              disabled={busy}
              onChange={(event) =>
                setDrafts((current) => ({
                  ...current,
                  [spec.field]: event.target.value,
                }))
              }
            />
            <span className={spec.set ? "state set" : "state"}>
              {spec.set
                ? "Stored. Typing here replaces it."
                : "Not stored yet."}
            </span>
          </div>
        ))}

        {fields.length > 0 ? (
          <button
            type="button"
            className="save"
            disabled={busy || pending.length === 0}
            onClick={() =>
              void saveCredentials(selected, Object.fromEntries(pending))
            }
          >
            {busy ? "Saving…" : "Save"}
          </button>
        ) : null}
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
