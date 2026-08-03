/**
 * iMessage settings app.
 *
 * A compiled React app served in the workspace panel. The host build maps
 * `react` / `react-dom` onto `preact/compat`, so this is ordinary React. It
 * talks to the plugin's routes under `/x/plugins/imessage/`.
 *
 * Two things it exists for: switching the provider (which tears down and
 * restarts ingress server-side, so it is a POST to its own route rather than a
 * settings field), and showing whether the channel is actually running. A
 * configured provider that failed to build reports `idleReason`, and surfacing
 * that is the difference between "misconfigured" and "silently broken".
 *
 * Requests go through `api.ts`, which reaches the routes over the host bridge
 * — never the global `fetch`, which cannot escape the sandbox.
 */

import React, { useCallback, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";

import { apiRequest, messageOf } from "./api.ts";

const BASE = "/x/plugins/imessage";

const PROVIDER_LABELS: Record<string, string> = {
  comms: "Comms by Osis",
  vellum: "Vellum-provided line",
};

const PROVIDER_HINTS: Record<string, string> = {
  comms:
    "Your own account and line. Requires a Comms API key in the credential store.",
  vellum: "Not available yet. Selecting it leaves the channel idle.",
};

/** Providers that cannot currently be brought up. */
const UNAVAILABLE_PROVIDERS = new Set(["vellum"]);

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
  .card {
    border: 1px solid color-mix(in srgb, CanvasText 15%, transparent);
    border-radius: 10px; padding: 16px; margin-bottom: 16px;
  }
  .row {
    display: flex; align-items: baseline; justify-content: space-between;
    gap: 16px; padding: 6px 0;
  }
  .row + .row {
    border-top: 1px solid color-mix(in srgb, CanvasText 8%, transparent);
  }
  .key { opacity: 0.7; }
  .val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; }
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
  .provider:disabled { opacity: 0.5; cursor: default; }
  .provider .name { font-weight: 600; }
  .provider .hint { opacity: 0.7; font-size: 13px; }
  .banner { border-radius: 8px; padding: 10px 12px; margin-bottom: 16px; font-size: 14px; }
  .banner.warn { background: color-mix(in srgb, Mark 40%, transparent); }
  .banner.err { background: color-mix(in srgb, LinkText 12%, transparent); }
  .ok { color: color-mix(in srgb, CanvasText 60%, AccentColor); }
`;

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
}

interface ProviderChange {
  config: Settings["config"];
  activeProvider: string | null;
  idleReason?: string | null;
}

function App(): React.ReactElement {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [idleReason, setIdleReason] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setSettings(
        await apiRequest<Settings>("Loading settings", `${BASE}/settings`),
      );
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
      setBusy(true);
      setError(null);
      const label = PROVIDER_LABELS[provider] ?? provider;
      try {
        const body = await apiRequest<ProviderChange>(
          `Switching to ${label}`,
          `${BASE}/provider`,
          {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ provider }),
          },
        );
        setIdleReason(body.idleReason ?? null);
        await load();
      } catch (err) {
        setError(messageOf(err));
      } finally {
        setBusy(false);
      }
    },
    [load],
  );

  if (error && !settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <div className="banner err">{error}</div>
      </div>
    );
  }

  if (!settings) {
    return (
      <div className="app">
        <style>{STYLES}</style>
        <p className="sub">Loading…</p>
      </div>
    );
  }

  const { config } = settings;
  const running = settings.activeProvider !== null && !idleReason;

  return (
    <div className="app">
      <style>{STYLES}</style>
      <h1>iMessage</h1>
      <p className="sub">
        People reach the assistant by texting a line it listens on.
      </p>

      {error ? <div className="banner err">{error}</div> : null}
      {idleReason ? (
        <div className="banner warn">
          Channel is idle: {idleReason}
        </div>
      ) : null}

      {/* Posting the active provider bounces its ingress, which is a useful
          way to recover a wedged poll worker without restarting the daemon. */}
      <h2>Provider</h2>
      <div className="providers">
        {settings.providers.map((id) => (
          <button
            key={id}
            type="button"
            className="provider"
            aria-pressed={config.provider === id}
            disabled={busy || UNAVAILABLE_PROVIDERS.has(id)}
            onClick={() => void switchProvider(id)}
          >
            <div>
              <div className="name">{PROVIDER_LABELS[id] ?? id}</div>
              <div className="hint">{PROVIDER_HINTS[id] ?? ""}</div>
            </div>
          </button>
        ))}
      </div>

      <h2>Status</h2>
      <div className="card">
        <div className="row">
          <span className="key">Configured provider</span>
          <span className="val">{config.provider}</span>
        </div>
        <div className="row">
          <span className="key">Running</span>
          <span className={running ? "val ok" : "val"}>
            {running ? (settings.activeProvider ?? "yes") : "idle"}
          </span>
        </div>
        <div className="row">
          <span className="key">Ingress</span>
          <span className="val">{config.ingressMode}</span>
        </div>
        {config.ingressMode === "poll" ? (
          <div className="row">
            <span className="key">Poll interval</span>
            <span className="val">{config.pollIntervalMs} ms</span>
          </div>
        ) : null}
        <div className="row">
          <span className="key">Send channel</span>
          <span className="val">{config.sendChannel ?? "provider decides"}</span>
        </div>
        <div className="row">
          <span className="key">Allowed handles</span>
          <span className="val">
            {config.allowedHandles.length === 0
              ? "all"
              : config.allowedHandles.join(", ")}
          </span>
        </div>
      </div>
    </div>
  );
}

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
