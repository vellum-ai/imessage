/**
 * Comms Messages API client.
 *
 * Thin wrapper over the documented endpoints at
 * `https://osis.co/api/v1/comms`, with bearer auth and the retry behavior the
 * errors-and-rate-limits guide calls for.
 *
 * Responses are parsed through the tolerant schemas in `schemas.ts` — a shape
 * the docs did not fully pin down must degrade, not throw.
 */

import type {
  CommsChannel,
  CommsMessage,
  ListMessagesResponse,
} from "./schemas.ts";
import {
  ListMessagesResponseSchema,
  SendMessageResponseSchema,
} from "./schemas.ts";

/** Comms Messages API base. */
export const COMMS_API_BASE = "https://osis.co/api/v1/comms";

/** Retries for a 429 or a 5xx. Beyond this the caller sees the failure. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class CommsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "CommsApiError";
  }

  /** Whether a retry could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface SendMessageInput {
  /** E.164 recipient. Required unless `conversationId` is set. */
  to?: string;
  /** Existing conversation. Required unless `to` is set. */
  conversationId?: string;
  body: string;
  channel?: CommsChannel;
  /**
   * Stable key so a retried send does not double-deliver. Comms answers 200
   * with `duplicate: true` instead of sending again.
   */
  idempotencyKey?: string;
}

export interface ListMessagesInput {
  conversationId?: string;
  /** ISO-8601 lower bound. */
  since?: string;
  direction?: "inbound" | "outbound";
  limit?: number;
}

export class CommsClient {
  /**
   * `getApiKey` is injected rather than imported so the client stays free of
   * credential policy: the BYOK adapter resolves the user's stored key, and a
   * platform-hosted caller can supply its own token source.
   */
  constructor(
    private readonly getApiKey: () => Promise<string>,
    private readonly baseUrl: string = COMMS_API_BASE,
  ) {}

  /**
   * `POST /messages`.
   *
   * Callers should always pass `idempotencyKey`. Without it a retried send
   * after a timeout delivers twice, which on a real phone line the recipient
   * sees.
   */
  async sendMessage(input: SendMessageInput): Promise<CommsMessage | undefined> {
    if (!input.to && !input.conversationId) {
      throw new Error("sendMessage requires either `to` or `conversationId`");
    }

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (input.idempotencyKey) {
      headers["Idempotency-Key"] = input.idempotencyKey;
    }

    const raw = await this.request("/messages", {
      method: "POST",
      headers,
      body: JSON.stringify({
        ...(input.to ? { to: input.to } : {}),
        ...(input.conversationId
          ? { conversation_id: input.conversationId }
          : {}),
        body: input.body,
        ...(input.channel ? { channel: input.channel } : {}),
      }),
    });

    return SendMessageResponseSchema.safeParse(raw).data?.message;
  }

  /** `GET /messages`. */
  async listMessages(
    input: ListMessagesInput = {},
  ): Promise<ListMessagesResponse> {
    const params = new URLSearchParams();
    if (input.conversationId)
      params.set("conversation_id", input.conversationId);
    if (input.since) params.set("since", input.since);
    if (input.direction) params.set("direction", input.direction);
    if (input.limit !== undefined) params.set("limit", String(input.limit));

    const query = params.toString();
    const raw = await this.request(`/messages${query ? `?${query}` : ""}`, {
      method: "GET",
    });

    const parsed = ListMessagesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : { messages: [] };
  }

  /** `POST /webhooks`. Needs the `comms_webhooks` scope. */
  async createWebhook(url: string, events: string[]): Promise<unknown> {
    return this.request("/webhooks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url, events }),
    });
  }

  /** `GET /webhooks`. */
  async listWebhooks(): Promise<unknown> {
    return this.request("/webhooks", { method: "GET" });
  }

  /**
   * One authenticated request, retrying 429s and 5xx with exponential backoff.
   *
   * The API key is resolved per request rather than cached, so a rotated key
   * takes effect without a restart.
   */
  private async request(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const apiKey = await this.getApiKey();
    let lastError: CommsApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }

      const response = await fetch(`${this.baseUrl}${path}`, {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${apiKey}`,
        },
      });

      if (response.ok) {
        return await response.json().catch(() => ({}));
      }

      const body = await response.text().catch(() => undefined);
      lastError = new CommsApiError(
        `Comms API ${init.method ?? "GET"} ${path} failed: ${response.status}`,
        response.status,
        body,
      );

      if (!lastError.retryable) throw lastError;
    }

    throw lastError ?? new CommsApiError("Comms API request failed", 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
