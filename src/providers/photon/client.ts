/**
 * Photon (Spectrum) client.
 *
 * Photon splits into two hosts, and the split is the only complicated thing
 * about this provider:
 *
 * - **Control plane** — `https://spectrum.photon.codes`, `Authorization: Basic
 *   base64(projectId:projectSecret)`. Projects, lines, webhooks, and the token
 *   mint. It cannot send a message.
 * - **Message plane** — `https://imessage.spectrum.photon.codes`,
 *   `Authorization: Bearer <token>` where the token is minted from the control
 *   plane and expires. Sends, chat creation, and message listing.
 *
 * So every message-plane call is really two: mint a token if the cached one is
 * gone or stale, then make the call. The mint is cached until shortly before
 * its own `expiresIn` so a busy line does not mint per message, and a 401 on
 * the message plane drops the cache and retries once — a token that expired
 * mid-flight is an expected event, not an error worth surfacing.
 *
 * Photon also ships an official SDK that speaks gRPC (and a generated HTTP
 * client over the same service). This talks to the documented HTTP routes with
 * `fetch` instead, matching `CommsClient` and keeping the plugin's dependency
 * list at zod. The paths and payload names below come from that SDK's own
 * request mapping.
 */

import { describeApiFailure } from "../error-detail.ts";
import {
  ChatSchema,
  CreateChatResponseSchema,
  EnvelopeSchema,
  IMessageInfoSchema,
  ListMessagesResponseSchema,
  ListWebhooksResponseSchema,
  PhotonMessageSchema,
  PhotonWebhookSchema,
  ProjectSchema,
  SendTextResponseSchema,
  TokenResponseSchema,
} from "./schemas.ts";
import type {
  IMessageInfo,
  ListMessagesResponse,
  PhotonMessage,
  PhotonProject,
  PhotonWebhook,
  TokenResponse,
} from "./schemas.ts";
import { resolveCredentialField } from "../../config.ts";

/** Spectrum Cloud control plane. */
export const PHOTON_CLOUD_BASE = "https://spectrum.photon.codes";

/** iMessage message plane. The SDK's own default middleware address. */
export const PHOTON_IMESSAGE_BASE = "https://imessage.spectrum.photon.codes";

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

/** The message plane rejects a page size outside this range. */
const MAX_PAGE_SIZE = 100;

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
  expiresAt: number;
}

export interface SendTextInput {
  chatGuid: string;
  text: string;
  /** Stable key so a retried send does not double-deliver. */
  clientMessageId: string;
}

export interface CreateChatInput {
  addresses: string[];
  clientMessageId: string;
  /** Sent in the same round trip as the chat creation when present. */
  text?: string;
}

export interface ListRecentInput {
  /** RFC 3339 lower bound. Photon returns messages created after it. */
  after?: string;
  limit: number;
  /** `false` asks for incoming only, which is all this plugin wants. */
  isFromMe?: boolean;
}

export class PhotonClient {
  /**
   * Hosts and credential fields are fixed, not injected — same reasoning as
   * `CommsClient`. There is one Photon deployment and one pair of credentials
   * this client can use, so passing either in would only create a way for a
   * caller to be wrong. Tests stub `fetch` and mock `resolveCredential`.
   */
  private readonly cloudBase = PHOTON_CLOUD_BASE;
  private readonly messageBase = PHOTON_IMESSAGE_BASE;
  private cachedToken?: CachedToken;

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

  /** `POST /v1/messages:sendText`. */
  async sendText(input: SendTextInput): Promise<PhotonMessage | undefined> {
    const raw = await this.messageRequest("/v1/messages:sendText", {
      method: "POST",
      body: JSON.stringify({
        chatGuid: input.chatGuid,
        text: input.text,
        clientMessageId: input.clientMessageId,
      }),
      idempotencyKey: input.clientMessageId,
    });
    return SendTextResponseSchema.safeParse(raw).data?.message;
  }

  /**
   * `POST /v1/chats` — resolve a chat for one or more addresses.
   *
   * iMessage keys a chat by its participants, so this returns the existing
   * chat for an address rather than piling up duplicates. Passing `text` sends
   * the opening message in the same round trip, which is what makes a cold
   * send to a bare handle one call instead of two.
   */
  async createChat(
    input: CreateChatInput,
  ): Promise<{ chatGuid?: string; message?: PhotonMessage }> {
    const raw = await this.messageRequest("/v1/chats", {
      method: "POST",
      body: JSON.stringify({
        addresses: input.addresses,
        // CHAT_SERVICE_TYPE_IMESSAGE. Protobuf-JSON takes the ordinal, which
        // is what the vendor SDK sends.
        service: 1,
        clientMessageId: input.clientMessageId,
        ...(input.text === undefined
          ? {}
          : { initialMessage: { text: input.text } }),
      }),
      idempotencyKey: input.clientMessageId,
    });

    const parsed = CreateChatResponseSchema.safeParse(raw);
    return {
      chatGuid: ChatSchema.safeParse(parsed.data?.chat).data?.guid,
      message: PhotonMessageSchema.safeParse(parsed.data?.initialMessage).data,
    };
  }

  /** `GET /v1/messages:listRecent`. */
  async listRecent(input: ListRecentInput): Promise<ListMessagesResponse> {
    const params = new URLSearchParams();
    params.set("pageSize", String(Math.min(input.limit, MAX_PAGE_SIZE)));
    if (input.after) params.set("after", input.after);
    if (input.isFromMe !== undefined) {
      params.set("isFromMe", String(input.isFromMe));
    }

    const raw = await this.messageRequest(
      `/v1/messages:listRecent?${params.toString()}`,
      { method: "GET" },
    );

    const parsed = ListMessagesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : { messages: [] };
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

  /**
   * One message-plane request, with a token minted as needed.
   *
   * A 401 drops the cached token and retries once: a token expiring mid-flight
   * is routine, and making the caller handle it would push token lifetime up
   * through the provider seam where it does not belong.
   */
  private async messageRequest(
    path: string,
    init: { method: string; body?: string; idempotencyKey?: string },
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const token = await this.token();
      try {
        return await this.withRetries(
          `${this.messageBase}${path}`,
          () => ({
            method: init.method,
            headers: {
              Authorization: `Bearer ${token.token}`,
              ...(token.instanceId
                ? { "x-photon-server": token.instanceId }
                : {}),
              ...(init.idempotencyKey
                ? { "x-idempotency-key": init.idempotencyKey }
                : {}),
              ...(init.body ? { "Content-Type": "application/json" } : {}),
            },
            ...(init.body ? { body: init.body } : {}),
          }),
          `Photon ${init.method} ${path}`,
        );
      } catch (err) {
        const expired =
          err instanceof PhotonApiError && err.status === 401 && attempt === 0;
        if (!expired) throw err;
        this.forgetToken();
      }
    }

    // Unreachable: the loop either returns or throws.
    throw new PhotonApiError(`Photon ${init.method} ${path} failed`, 0);
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

      const response = await fetch(url, buildInit());
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
