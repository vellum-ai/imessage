/**
 * Photon (Spectrum) client.
 *
 * Photon splits into two hosts, and the split is the only complicated thing
 * about this provider:
 *
 * - **Control plane** — `https://spectrum.photon.codes`, `Authorization: Basic
 *   base64(projectId:projectSecret)`. REST, with a `{ succeed, data }`
 *   envelope. Projects, lines, webhooks, and the token mint. It cannot send a
 *   message. This file speaks it directly, with `fetch`.
 * - **Message plane** — gRPC behind Envoy, bearer-authenticated with a token
 *   minted from the control plane. Sends, chat resolution, message listing.
 *   It does not serve REST in any form, so the vendor's SDK owns that half;
 *   see `message-client.ts`.
 *
 * So every message-plane call is really two: mint a token if the cached one is
 * gone or stale, then make the call. The mint is cached until shortly before
 * its own `expiresIn` so a busy line does not mint per message, and the SDK
 * resolves the token per RPC, so a rotation costs a mint rather than a
 * reconnect.
 */

import {
  EnvelopeSchema,
  IMessageInfoSchema,
  ListWebhooksResponseSchema,
  PhotonWebhookSchema,
  PhotonUserSchema,
  ProjectSchema,
  TokenResponseSchema,
} from "./schemas.ts";
import type {
  IMessageInfo,
  PhotonProject,
  PhotonUser,
  PhotonWebhook,
  TokenResponse,
} from "./schemas.ts";
import { resolveCredentialField } from "../../config.ts";
import { describeApiFailure, describeError } from "../error-detail.ts";
import type {
  AddressReport,
  CreateChatInput,
  EventStream,
  ListRecentInput,
  MessageClient,
  MessageClientFactory,
  MessageListPage,
  PhotonLiveEvent,
  PhotonMessage,
  SendTextInput,
} from "./message-client.ts";
import { createMessageClient } from "./message-client.ts";

/** Spectrum Cloud control plane. Plain REST, and the half this file speaks. */
export const PHOTON_CLOUD_BASE = "https://spectrum.photon.codes";

/**
 * iMessage message plane, as a gRPC address.
 *
 * This host does not serve REST. It is Envoy in front of the iMessage service,
 * and it answers 415 with an empty body to anything that is not gRPC —
 * including a bodiless `GET /`, which is how the plugin's earlier REST client
 * failed: every send returned `415` and no explanation, because there was no
 * response body to explain anything.
 *
 * The paths that client used (`POST /v1/chats`, `POST /v1/messages:sendText`)
 * are real, but they belong to `imessage-server-v2-http`, a middleware Photon
 * publishes as software rather than hosting. Reaching the hosted plane means
 * speaking gRPC, so the SDK owns this half.
 */
export const PHOTON_IMESSAGE_ADDRESS = "imessage.spectrum.photon.codes:443";

export const PROJECT_ID_FIELD = "photon_project_id";
export const PROJECT_SECRET_FIELD = "photon_project_secret";

/** Retries for a 429 or a 5xx. Beyond this the caller sees the failure. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

/**
 * Mint a new token this many ms before the old one expires.
 *
 * A token that expires between the check and the call would surface as a 401
 * the caller has to absorb. The retry below handles it anyway; this just keeps
 * that from being the normal path.
 */
const TOKEN_REFRESH_MARGIN_MS = 30_000;

/** Fallback lifetime when the mint does not say. Deliberately short. */
const DEFAULT_TOKEN_TTL_MS = 5 * 60_000;

export class PhotonApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "PhotonApiError";
  }

  /** Whether a retry could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

interface CachedToken {
  token: string;
  /** Dedicated projects route by instance; shared projects have no instance. */
  instanceId?: string;
  /** The instance's own line, which a dedicated user has to be assigned to. */
  lineNumber?: string;
  expiresAt: number;
}

export class PhotonClient {
  /**
   * Hosts and credential fields are fixed, not injected — same reasoning as
   * `CommsClient`. There is one Photon deployment and one pair of credentials
   * this client can use, so passing either in would only create a way for a
   * caller to be wrong. Tests stub `fetch` and mock `resolveCredential`.
   *
   * The message-client factory is the exception: it opens a real gRPC channel,
   * so a test would otherwise have to dial the network to exercise a send.
   */
  private readonly cloudBase = PHOTON_CLOUD_BASE;
  private cachedToken?: CachedToken;
  private messages?: MessageClient;

  constructor(
    private readonly makeMessageClient: MessageClientFactory = createMessageClient,
  ) {}

  /** `GET /projects/{projectId}/` — the cheapest proof the credentials work. */
  async getProject(): Promise<PhotonProject> {
    const data = await this.cloudRequest("/", { method: "GET" });
    const parsed = ProjectSchema.safeParse(data);
    if (!parsed.success) {
      throw new PhotonApiError("Photon returned an unreadable project", 0);
    }
    return parsed.data;
  }

  /** `GET /projects/{projectId}/imessage/` — shared or dedicated line. */
  async getIMessageInfo(): Promise<IMessageInfo> {
    const data = await this.cloudRequest("/imessage/", { method: "GET" });
    const parsed = IMessageInfoSchema.safeParse(data);
    if (!parsed.success) {
      throw new PhotonApiError(
        "Photon did not report an iMessage service type for this project",
        0,
      );
    }
    return parsed.data;
  }

  /** `POST /projects/{projectId}/imessage/tokens` — mint a message-plane token. */
  async issueToken(): Promise<TokenResponse> {
    const data = await this.cloudRequest("/imessage/tokens", {
      method: "POST",
    });
    const parsed = TokenResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new PhotonApiError(
        "Photon returned a token response this plugin does not understand",
        0,
      );
    }
    return parsed.data;
  }

  /**
   * `POST /projects/{projectId}/users/` — make a handle messageable.
   *
   * A Photon project may only message people it knows. Photon's own word for
   * one is a *user*, not an allowlist entry, and the distinction is load
   * bearing: a shared project allocates each user their own line out of a
   * pool, so creating one is a provisioning step rather than a permission
   * flag. The message plane refuses anyone else with "Target not allowed for
   * this project", which is a policy answer that reads exactly like a
   * transport failure.
   *
   * Idempotent by Photon's own contract — a shared user is keyed on
   * `phoneNumber` and re-creating an active one returns the same row — so this
   * is safe on any path that might be the first send to a handle.
   *
   * Which shape depends on the project. A shared project lets the server
   * allocate; a dedicated one has to name a line it owns, and the token mint
   * already reports those (`numbers`), so this costs no extra call.
   */
  async ensureUser(phoneNumber: string): Promise<PhotonUser | undefined> {
    const info = await this.getIMessageInfo();

    let body: Record<string, unknown>;
    if (info.type === "shared") {
      body = { type: "shared", phoneNumber };
    } else {
      const assignedPhoneNumber = (await this.token()).lineNumber;
      if (!assignedPhoneNumber) {
        throw new PhotonApiError(
          `Photon reported a dedicated project with no line to assign ${phoneNumber} to — add a line to the project first`,
          0,
        );
      }
      body = { type: "dedicated", phoneNumber, assignedPhoneNumber };
    }

    const data = await this.cloudRequest("/users/", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return PhotonUserSchema.safeParse(data).data;
  }

  /** `GET /projects/{projectId}/webhooks/`. */
  async listWebhooks(): Promise<PhotonWebhook[]> {
    const data = await this.cloudRequest("/webhooks/", { method: "GET" });
    return ListWebhooksResponseSchema.safeParse(data).data ?? [];
  }

  /**
   * `POST /projects/{projectId}/webhooks/`.
   *
   * The response carries a `signingSecret` exactly once. It is dropped on
   * purpose: the gateway verifies deliveries against its own secret, so
   * holding Photon's would only imply a check nothing performs.
   */
  async createWebhook(url: string): Promise<PhotonWebhook | undefined> {
    const data = await this.cloudRequest("/webhooks/", {
      method: "POST",
      body: JSON.stringify({ webhookUrl: url }),
    });
    return PhotonWebhookSchema.safeParse(data).data;
  }

  /** `DELETE /projects/{projectId}/webhooks/{webhookId}`. */
  async deleteWebhook(id: string): Promise<void> {
    await this.cloudRequest(`/webhooks/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /**
   * The message plane, opened on first use and reused after that.
   *
   * Lazy because most of what this client does is control plane: reading a
   * project, listing webhooks, minting a token. Opening a gRPC channel for a
   * readiness check nobody follows with a send would be a connection held for
   * nothing.
   */
  private plane(): MessageClient {
    this.messages ??= this.makeMessageClient({
      token: async () => (await this.token()).token,
    });
    return this.messages;
  }

  /** Send to a chat that already exists. */
  async sendText(input: SendTextInput): Promise<PhotonMessage | undefined> {
    return this.plane().sendText(input);
  }

  /**
   * Resolve a chat for one or more addresses.
   *
   * iMessage keys a chat by its participants, so this returns the existing
   * chat for an address rather than piling up duplicates. Passing `text` sends
   * the opening message in the same round trip, which is what makes a cold
   * send to a bare handle one call instead of two.
   */
  async createChat(
    input: CreateChatInput,
  ): Promise<{ chatGuid?: string; message?: PhotonMessage }> {
    const created = await this.plane().createChat(input);
    return {
      chatGuid: created.chat?.guid,
      ...(created.initialMessage ? { message: created.initialMessage } : {}),
    };
  }

  /** Recent messages on the line, newest-first, bounded by `after`. */
  async listRecent(input: ListRecentInput): Promise<MessageListPage> {
    return this.plane().listRecent(input);
  }

  /**
   * Live message events on the gRPC channel this client already holds.
   *
   * The same connection send uses. Opening a second one just to subscribe
   * would be a second keepalive and a second token, for nothing.
   */
  subscribeEvents(): EventStream<PhotonLiveEvent> {
    return this.plane().subscribeEvents();
  }

  /** What Photon makes of an address. Diagnostic only — see the seam. */
  async describeAddress(address: string): Promise<AddressReport> {
    return this.plane().describeAddress(address);
  }

  /**
   * Release the message-plane channel.
   *
   * A gRPC channel is a live connection with its own keepalive timer, so a
   * provider that is torn down and rebuilt — which every settings save does —
   * would otherwise leak one per save.
   */
  async close(): Promise<void> {
    const plane = this.messages;
    this.messages = undefined;
    await plane?.close();
  }

  /** Drop the cached token. Used by tests and after a 401. */
  forgetToken(): void {
    this.cachedToken = undefined;
  }

  /**
   * One control-plane request, unwrapped from the `{ succeed, data }` envelope.
   *
   * A `{ succeed: false, message }` body is an error even on a 200, so the
   * envelope is checked rather than the status alone.
   */
  private async cloudRequest(
    path: string,
    init: { method: string; body?: string },
  ): Promise<unknown> {
    const projectId = await resolveCredentialField(
      PROJECT_ID_FIELD,
      "The Photon project ID",
    );
    const secret = await resolveCredentialField(
      PROJECT_SECRET_FIELD,
      "The Photon project secret",
    );
    const auth = btoa(`${projectId}:${secret}`);

    const raw = await this.withRetries(
      `${this.cloudBase}/projects/${encodeURIComponent(projectId)}${path}`,
      () => ({
        method: init.method,
        headers: {
          Authorization: `Basic ${auth}`,
          ...(init.body ? { "Content-Type": "application/json" } : {}),
        },
        ...(init.body ? { body: init.body } : {}),
      }),
      `Photon ${init.method} ${path}`,
    );

    const envelope = EnvelopeSchema.safeParse(raw);
    if (!envelope.success) return raw;
    if (!envelope.data.succeed) {
      throw new PhotonApiError(
        `Photon ${init.method} ${path} failed: ${envelope.data.message ?? "no reason given"}`,
        0,
      );
    }
    return envelope.data.data;
  }

  /** The cached message-plane token, minting a new one when it is due. */
  private async token(): Promise<CachedToken> {
    const cached = this.cachedToken;
    if (cached && cached.expiresAt > Date.now()) return cached;

    const minted = await this.issueToken();
    const ttlMs =
      minted.expiresIn === undefined
        ? DEFAULT_TOKEN_TTL_MS
        : minted.expiresIn * 1000;
    const expiresAt = Date.now() + Math.max(0, ttlMs - TOKEN_REFRESH_MARGIN_MS);

    if (minted.type === "shared") {
      this.cachedToken = { token: minted.token, expiresAt };
      return this.cachedToken;
    }

    // Dedicated: one token per instance. This plugin drives a single line, so
    // it takes the first — picking arbitrarily among several is better than
    // failing, and a project with more than one dedicated instance is a
    // configuration this plugin does not model yet.
    const entries = Object.entries(minted.auth);
    const first = entries[0];
    if (!first) {
      throw new PhotonApiError(
        "Photon issued no iMessage tokens for this project — check that the project has an active line",
        0,
      );
    }
    this.cachedToken = {
      token: first[1],
      instanceId: first[0],
      ...(minted.numbers?.[first[0]]
        ? { lineNumber: minted.numbers[first[0]] }
        : {}),
      expiresAt,
    };
    return this.cachedToken;
  }

  /**
   * One request, retrying 429s and 5xx with exponential backoff.
   *
   * `buildInit` is a thunk so a retry re-reads nothing stale; the caller's
   * headers are rebuilt per attempt.
   */
  private async withRetries(
    url: string,
    buildInit: () => RequestInit,
    label: string,
  ): Promise<unknown> {
    let lastError: PhotonApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }

      // See the matching note in the Comms client: a transport failure rejects
      // with the reason on `.cause`, and unwrapped it names neither the
      // request nor the cause.
      let response: Response;
      try {
        response = await fetch(url, buildInit());
      } catch (err) {
        throw new PhotonApiError(
          `${label} could not be reached: ${describeError(err)}`,
          0,
        );
      }
      if (response.ok) {
        return await response.json().catch(() => ({}));
      }

      const body = await response.text().catch(() => undefined);
      lastError = new PhotonApiError(
        describeApiFailure(label, response.status, body),
        response.status,
        body,
      );

      if (!lastError.retryable) throw lastError;
    }

    throw lastError ?? new PhotonApiError(`${label} failed`, 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
