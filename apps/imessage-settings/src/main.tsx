/**
 * iMessage settings app.
 *
 * A compiled React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/imessage/`.
 *
 * One job: get the channel onto a provider that can actually send. That means
 * picking the provider and filling in the credentials it needs — the step that
 * was previously only possible from a terminal.
 *
 * The shape follows the assistant's own BYO-service forms
 * (`clients/web/src/components/speech/stt-provider-form.tsx` in
 * vellum-assistant): title and subtitle, a provider dropdown, the provider's
 * key fields, a "where do I get this" callout, and a right-aligned Save that
 * only lights up when something changed. Selecting a provider is a draft until
 * Save, which is also what stops a click on the provider you are already using
 * from restarting your channel.
 *
 * It cannot import that design library — this runs sandboxed, with no access
 * to the host's stylesheet or its CSS custom properties — so the styling below
 * reproduces the same structure against system colors.
 *
 * Requests go through `api.ts`, which reaches the routes over the host bridge
 * — never the global `fetch`, which cannot escape the sandbox.
 */

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiRequest, messageOf } from "./api.ts";

const BASE = "/x/plugins/imessage";

/** Where to get the credentials a provider needs. */
interface CredentialsGuide {
  description: string;
  url: string;
  linkLabel: string;
}

interface ProviderCatalogEntry {
  id: string;
  displayName: string;
  subtitle: string;
  credentialsGuide: CredentialsGuide;
}

/**
 * Display copy for the providers this build knows about.
 *
 * Which providers actually exist comes from the plugin; this only says how to
 * describe them. An id the plugin reports that is missing here means the two
 * are out of step, which the app says out loud rather than rendering a bare id.
 */
const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
  {
    id: "comms",
    displayName: "Comms by Osis",
    subtitle:
      "Your own Comms workspace and line. One API key covers sending and receiving.",
    credentialsGuide: {
      description:
        "Sign in to Comms by Osis, provision a line, and mint a Messages API key with the comms_send and comms_read scopes. Scopes are fixed at creation — a key missing one has to be replaced.",
      url: "https://comms.osis.co",
      linkLabel: "Open Comms by Osis",
    },
  },
  {
    id: "photon",
    displayName: "Photon",
    subtitle:
      "Your own Photon project. The project ID and secret mint the token its line is reached with.",
    credentialsGuide: {
      description:
        "Sign in to the Photon dashboard, open your project, and copy its project ID and project secret. The line comes from the project — there is nothing to provision separately.",
      url: "https://photon.codes",
      linkLabel: "Open Photon Dashboard",
    },
  },
];

const STYLES = `
  :root { color-scheme: light dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font: 15px/1.5 system-ui, -apple-system, Segoe UI, Roboto, sans-serif;
    background: Canvas;
    color: CanvasText;
  }
  .app { max-width: 640px; margin: 0 auto; padding: 24px 20px 64px; }
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 12px;
    padding: 20px;
  }
  .card h1 { font-size: 18px; font-weight: 600; margin: 0; }
  .card .subtitle {
    margin: 4px 0 0;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .divider {
    border: 0;
    border-top: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    margin: 16px 0;
  }
  .stack { display: grid; gap: 16px; }
  .field { display: grid; gap: 4px; }
  .field label {
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .field .note {
    margin: 0;
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 60%, transparent);
  }
  .field select, .field input {
    font: inherit;
    width: 100%;
    padding: 8px 10px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 22%, transparent);
    background: color-mix(in srgb, CanvasText 4%, Canvas);
    color: CanvasText;
  }
  .field select:disabled, .field input:disabled { opacity: 0.6; }
  .guide {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    padding: 12px;
    border-radius: 8px;
    border: 1px solid color-mix(in srgb, CanvasText 12%, transparent);
    background: color-mix(in srgb, CanvasText 5%, transparent);
    font-size: 13px;
    color: color-mix(in srgb, CanvasText 65%, transparent);
  }
  .guide .icon { flex: none; margin-top: 1px; }
  .guide .body { display: flex; flex-direction: column; gap: 4px; }
  .guide a {
    display: inline-flex; align-items: center; gap: 4px;
    color: AccentColor; text-decoration: underline;
  }
  .guide a:hover { opacity: 0.8; }
  .actions { display: flex; align-items: center; justify-content: flex-end; gap: 8px; }
  button {
    font: inherit; font-size: 14px; padding: 7px 14px;
    border-radius: 8px; cursor: pointer;
  }
  button.save {
    font-weight: 600; color: Canvas; background: AccentColor;
    border: 1px solid AccentColor;
  }
  button.save:disabled { opacity: 0.45; cursor: default; }
  button.reset {
    background: transparent; border: 1px solid transparent;
    color: color-mix(in srgb, CanvasText 45%, red);
  }
  button.reset:hover { background: color-mix(in srgb, red 10%, transparent); }
  .banner {
    border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 13px;
  }
  .banner.warn { background: color-mix(in srgb, Mark 40%, transparent); }
  .banner.err { background: color-mix(in srgb, LinkText 12%, transparent); }
  .banner.info { background: color-mix(in srgb, CanvasText 8%, transparent); }
`;

/** One credential a provider needs, and whether the store already has it. */
interface CredentialField {
  field: string;
  label: string;
  placeholder: string;
  secret: boolean;
  set: boolean;
}

type Credentials = Record<string, CredentialField[]>;

/** What `startChannelRuntime` did, as the routes report it. */
type ChannelStatus = "running" | "idle" | "not-loaded";

interface Settings {
  config: { provider: string };
  providers: string[];
  activeProvider: string | null;
  /**
   * Absent when the running plugin predates the credentials route. Optional
   * here on purpose: "the plugin did not say" and "this provider needs
   * nothing" are different answers, and rendering the first as the second is
   * how the app ends up claiming Comms needs no API key.
   */
  credentials?: Credentials;
}

interface ChannelResult {
  status?: ChannelStatus | null;
  idleReason?: string | null;
  credentials?: Credentials;
}

interface Notice {
  tone: "info" | "warn";
  text: string;
}

const KNOWN_PROVIDERS = new Map(
  PROVIDER_CATALOG.map((entry) => [entry.id, entry]),
);

function labelFor(provider: string): string {
  return KNOWN_PROVIDERS.get(provider)?.displayName ?? provider;
}

/**
 * Turn a channel result into something worth reading.
 *
 * `not-loaded` is the case that used to surface as "Channel is idle: plugin is
 * not initialized" — which sounded like a breakage when it only meant the
 * route could not reach a running channel in its own process. The write
 * happened; it applies on the next load. Say that.
 */
function noticeFor(result: ChannelResult, what: string): Notice {
  switch (result.status) {
    case "running":
      return { tone: "info", text: `${what} The channel is running.` };
    case "idle":
      return {
        tone: "warn",
        text: `${what} The channel is not running: ${
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

function InfoIcon(): React.ReactElement {
  return (
    <svg
      className="icon"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <circle cx="12" cy="12" r="10" />
      <path d="M12 16v-4M12 8h.01" strokeLinecap="round" />
    </svg>
  );
}

function ExternalLinkIcon(): React.ReactElement {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      aria-hidden="true"
    >
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <path d="M15 3h6v6M10 14 21 3" />
    </svg>
  );
}

function App(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draftProvider, setDraftProvider] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [notice, setNotice] = useState<Notice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const next = await apiRequest<Settings>(
        "Loading settings",
        `${BASE}/settings`,
      );
      setSettings(next);
      // Follow the configured provider unless a draft is already on screen: a
      // reload must not silently move the panel off what the user is editing.
      setDraftProvider((current) => current ?? next.config.provider);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const serverProvider = settings?.config.provider ?? null;

  /**
   * Providers the plugin offers, in catalog order, plus any it reports that
   * this build has never heard of.
   */
  const options = useMemo(() => {
    const reported = settings?.providers ?? [];
    const known = PROVIDER_CATALOG.filter((entry) =>
      reported.includes(entry.id),
    ).map((entry) => ({ id: entry.id, label: entry.displayName }));
    const unknown = reported
      .filter((id) => !KNOWN_PROVIDERS.has(id))
      .map((id) => ({ id, label: id }));
    return [...known, ...unknown];
  }, [settings]);

  const unknownProviders = useMemo(
    () => (settings?.providers ?? []).filter((id) => !KNOWN_PROVIDERS.has(id)),
    [settings],
  );

  const catalog = draftProvider ? KNOWN_PROVIDERS.get(draftProvider) : undefined;
  const fields = draftProvider
    ? settings?.credentials?.[draftProvider]
    : undefined;

  const save = useCallback(async () => {
    if (!draftProvider || !settings) return;
    setSaving(true);
    setError(null);

    // Only fields belonging to the provider on screen, so a draft left over
    // from another provider can never ride along.
    const values = Object.fromEntries(
      (fields ?? [])
        .map((spec): [string, string] => [spec.field, drafts[spec.field] ?? ""])
        .filter(([, value]) => value.trim().length > 0),
    );

    try {
      let result: ChannelResult = {};
      let what = "Saved.";

      // Provider first, then credentials. The switch restarts ingress on a
      // provider whose key may be missing; storing the key restarts it again,
      // which is the pass that actually comes up.
      if (draftProvider !== settings.config.provider) {
        result = await apiRequest<ChannelResult>(
          `Switching to ${labelFor(draftProvider)}`,
          `${BASE}/provider`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: draftProvider }),
          },
        );
        what = `Switched to ${labelFor(draftProvider)}.`;
      }

      if (Object.keys(values).length > 0) {
        result = await apiRequest<ChannelResult>(
          "Saving credentials",
          `${BASE}/credentials`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider: draftProvider, values }),
          },
        );
      }

      setDrafts({});
      setNotice(noticeFor(result, what));
      await load();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setSaving(false);
    }
  }, [draftProvider, drafts, fields, load, settings]);

  const reset = useCallback(() => {
    setDrafts({});
    setDraftProvider(serverProvider);
    setNotice(null);
  }, [serverProvider]);

  if (error && !settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <div className="banner err">{error}</div>
      </div>
    );
  }

  if (!settings || !draftProvider) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  const typed = (fields ?? []).some(
    (spec) => (drafts[spec.field] ?? "").trim().length > 0,
  );
  const hasChanges = draftProvider !== serverProvider || typed;

  return (
    <div className="app">
      <style>{STYLES}</style>
      <section className="card">
        <h1>iMessage</h1>
        <p className="subtitle">
          People reach the assistant by texting a line it listens on.
        </p>
        <hr className="divider" />

        {error ? <div className="banner err">{error}</div> : null}
        {notice ? (
          <div className={`banner ${notice.tone}`}>{notice.text}</div>
        ) : null}
        {unknownProviders.length > 0 ? (
          <div className="banner warn">
            The running plugin still offers{" "}
            {unknownProviders.map((id) => `"${id}"`).join(", ")}, which this
            panel does not know about. Reload the plugin so the two match.
          </div>
        ) : null}

        <div className="stack">
          <div className="field">
            <label htmlFor="provider">Provider</label>
            <select
              id="provider"
              value={draftProvider}
              disabled={saving}
              onChange={(event) => {
                setDraftProvider(event.target.value);
                setDrafts({});
              }}
            >
              {options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
            {catalog ? <p className="note">{catalog.subtitle}</p> : null}
          </div>

          {fields === undefined ? (
            <div className="banner warn" style={{ margin: 0 }}>
              The running plugin does not report which credentials this provider
              needs, so there is nothing to fill in here yet. Reload the plugin,
              or set the credential from a terminal with{" "}
              <code>assistant credentials set --service imessage</code>.
            </div>
          ) : null}

          {(fields ?? []).map((spec) => (
            <div className="field" key={spec.field}>
              <label htmlFor={spec.field}>{spec.label}</label>
              <input
                id={spec.field}
                // A stored value is never sent back to the app, so the input
                // starts empty whether or not one exists. The placeholder is
                // what tells the two apart.
                type={spec.secret ? "password" : "text"}
                autoComplete="off"
                spellCheck={false}
                placeholder={
                  spec.set
                    ? "••••••••  (Enter a new value to replace)"
                    : spec.placeholder
                }
                value={drafts[spec.field] ?? ""}
                disabled={saving}
                onChange={(event) =>
                  setDrafts((current) => ({
                    ...current,
                    [spec.field]: event.target.value,
                  }))
                }
              />
            </div>
          ))}

          {catalog && fields !== undefined ? (
            <div className="guide">
              <InfoIcon />
              <div className="body">
                <span>{catalog.credentialsGuide.description}</span>
                <a
                  href={catalog.credentialsGuide.url}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  {catalog.credentialsGuide.linkLabel}
                  <ExternalLinkIcon />
                </a>
              </div>
            </div>
          ) : null}

          <div className="actions">
            <button
              type="button"
              className="save"
              disabled={!hasChanges || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            {/*
              The assistant's own forms use Reset to delete a stored key. The
              plugin API has no way to remove a credential — only to set one —
              so this reverts the form to what is saved rather than pretending
              to clear the store.
            */}
            {hasChanges ? (
              <button
                type="button"
                className="reset"
                disabled={saving}
                onClick={reset}
              >
                Reset
              </button>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
