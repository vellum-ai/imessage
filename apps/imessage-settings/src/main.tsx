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
 * Display copy for each provider.
 *
 * Which providers exist comes from the plugin; this only says how to describe
 * them.
 */
const PROVIDER_CATALOG: readonly ProviderCatalogEntry[] = [
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
];

/**
 * Display copy for each ingress mode. Which ones exist comes from the plugin,
 * the same way the provider list does; this only says how to describe them.
 *
 * Webhook is the default and the one to use: the provider pushes, so a text
 * becomes a turn in about a second. Polling exists for a deployment the
 * provider cannot reach — no tunnel, no public ingress URL — where a webhook
 * would be registered against a URL that answers nothing. Without this control
 * such a deployment had no way off the default from here.
 *
 * `pollIntervalMs` is deliberately absent. It is bounded in the config schema,
 * its default is right for both providers' rate limits, and someone who
 * genuinely needs to tune it can edit `config.json` — which is a better trade
 * than a number input that mostly invites people to set it to 500.
 */
const INGRESS_MODE_CATALOG = [
  {
    id: "webhook",
    label: "Webhook (recommended)",
    note: "The provider delivers each message as it arrives. Needs a public ingress URL the provider can reach.",
  },
  {
    id: "poll",
    label: "Polling",
    note: "The plugin checks for new messages on a timer. Slower, but works where the provider cannot reach this assistant.",
  },
] as const;

type IngressMode = (typeof INGRESS_MODE_CATALOG)[number]["id"];

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
type ChannelStatus = "running" | "idle";

/** What the plugin's last webhook registration attempt did, if any. */
interface WebhookReport {
  provider: string;
  outcome: "registered" | "already-registered" | "skipped" | "failed";
  url?: string;
  reason?: string;
  at: string;
}

interface Settings {
  config: { provider: string; ingressMode: IngressMode };
  providers: string[];
  ingressModes: string[];
  activeProvider: string | null;
  /** Every provider's fields, keyed by provider id. */
  credentials: Credentials;
  webhook: WebhookReport | null;
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
 * Two states, and only one of them is worth alarming about. A save used to be
 * able to come back "it takes effect the next time the assistant loads this
 * plugin", which was true and useless: the switch had already happened, and
 * the sentence read as a warning about something the user then could not act
 * on. The runtime no longer reports that state.
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
    default:
      return { tone: "info", text: what };
  }
}

/**
 * One line about the last registration attempt, or nothing.
 *
 * Only shown in webhook mode, where it is the difference between "inbound is
 * set up" and "inbound is silent and you cannot see why". A failure or a skip
 * carries the provider's own reason, since that is what says whether the fix
 * is a credential, a public URL, or nothing you control.
 */
function describeWebhook(
  report: WebhookReport | null,
  ingressMode: IngressMode | null,
): string | null {
  if (ingressMode !== "webhook") return null;
  if (!report) {
    return "No webhook registration has been attempted since this plugin loaded.";
  }
  switch (report.outcome) {
    case "registered":
      return `Registered with ${report.provider} at ${report.url}.`;
    case "already-registered":
      return `Already registered with ${report.provider} at ${report.url}.`;
    case "skipped":
      return `Not registered: ${report.reason ?? "no reason given"}`;
    case "failed":
      return `Registration failed: ${report.reason ?? "no reason given"}`;
    default:
      return null;
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
  const [draftIngress, setDraftIngress] = useState<IngressMode | null>(null);
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
      // Follow the configured values unless a draft is already on screen: a
      // reload must not silently move the panel off what the user is editing.
      setDraftProvider((current) => current ?? next.config.provider);
      setDraftIngress((current) => current ?? next.config.ingressMode);
      setError(null);
    } catch (err) {
      setError(messageOf(err));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const serverProvider = settings?.config.provider ?? null;
  const serverIngress = settings?.config.ingressMode ?? null;

  /** Providers the plugin offers, in catalog order. */
  const options = useMemo(
    () =>
      PROVIDER_CATALOG.filter((entry) =>
        (settings?.providers ?? []).includes(entry.id),
      ),
    [settings],
  );

  /** Ingress modes the plugin offers, in catalog order. */
  const ingressOptions = useMemo(
    () =>
      INGRESS_MODE_CATALOG.filter((mode) =>
        (settings?.ingressModes ?? []).includes(mode.id),
      ),
    [settings],
  );

  const catalog = draftProvider ? KNOWN_PROVIDERS.get(draftProvider) : undefined;
  const fields: CredentialField[] = draftProvider
    ? (settings?.credentials[draftProvider] ?? [])
    : [];

  const save = useCallback(async () => {
    if (!draftProvider || !draftIngress || !settings) return;
    setSaving(true);
    setError(null);

    // Only fields belonging to the provider on screen, so a draft left over
    // from another provider can never ride along.
    const values = Object.fromEntries(
      fields
        .map((spec): [string, string] => [spec.field, drafts[spec.field] ?? ""])
        .filter(([, value]) => value.trim().length > 0),
    );

    try {
      let result: ChannelResult = {};
      let what = "Saved.";

      // Provider, then ingress mode, then credentials. Each of the three
      // restarts the channel, so the order decides which restart is the one
      // still standing when the notice is written — and that should be the
      // last pass, on the final configuration, with the key in place. Doing
      // credentials first would report on a channel two edits out of date.
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

      if (draftIngress !== settings.config.ingressMode) {
        result = await apiRequest<ChannelResult>(
          "Saving ingress mode",
          `${BASE}/settings`,
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ ingressMode: draftIngress }),
          },
        );
        // `what` is left alone: it already reads "Saved.", and when the
        // provider also changed, "Switched to Photon." is the more useful
        // sentence to keep.
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
  }, [draftIngress, draftProvider, drafts, fields, load, settings]);

  const reset = useCallback(() => {
    setDrafts({});
    setDraftProvider(serverProvider);
    setDraftIngress(serverIngress);
    setNotice(null);
  }, [serverIngress, serverProvider]);

  if (error && !settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <div className="banner err">{error}</div>
      </div>
    );
  }

  if (!settings || !draftProvider || !draftIngress) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <p className="subtitle">Loading…</p>
      </div>
    );
  }

  const typed = fields.some(
    (spec) => (drafts[spec.field] ?? "").trim().length > 0,
  );
  const hasChanges =
    draftProvider !== serverProvider || draftIngress !== serverIngress || typed;
  const ingress = ingressOptions.find((mode) => mode.id === draftIngress);
  const webhookNote = describeWebhook(settings.webhook, serverIngress);

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
                  {option.displayName}
                </option>
              ))}
            </select>
            {catalog ? <p className="note">{catalog.subtitle}</p> : null}
          </div>

          {fields.map((spec) => (
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

          {catalog ? (
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

          <div className="field">
            <label htmlFor="ingressMode">Inbound messages</label>
            <select
              id="ingressMode"
              value={draftIngress}
              disabled={saving}
              onChange={(event) =>
                setDraftIngress(event.target.value as IngressMode)
              }
            >
              {ingressOptions.map((mode) => (
                <option key={mode.id} value={mode.id}>
                  {mode.label}
                </option>
              ))}
            </select>
            {ingress ? <p className="note">{ingress.note}</p> : null}
            {webhookNote ? <p className="note">{webhookNote}</p> : null}
          </div>

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
