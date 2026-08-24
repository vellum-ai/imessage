/**
 * Linq Partner API v3 client.
 *
 * Thin wrapper over the documented endpoints at
 * `https://api.linqapp.com/api/partner/v3`, with bearer auth and the retry
 * behavior the rate-limits guide calls for (429 and 5xx).
 *
 * Responses are parsed through the tolerant schemas in `schemas.ts` — a shape
 * the docs did not fully pin down must degrade, not throw.
 */

import { resolveLinqApiKey } from "../../config.ts";
import { describeApiFailure, describeError } from "../error-detail.ts";
import type {
  LinqChat,
  LinqMessage,
  ListChatsResponse,
  ListMessagesResponse,
} from "./schemas.ts";
import {
  LINQ_WEBHOOK_EVENTS,
  ListChatsResponseSchema,
  ListMessagesResponseSchema,
  ListPhoneNumbersResponseSchema,
  SendMessageResponseSchema,
} from "./schemas.ts";

/** Linq Partner API v3 base. */
export const LINQ_API_BASE = "https://api.linqapp.com/api/partner/v3";

/** Retries for a 429 or a 5xx. Beyond this the caller sees the failure. */
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 500;

export class LinqApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "LinqApiError";
  }

  /** Whether a retry could plausibly succeed. */
  get retryable(): boolean {
    return this.status === 429 || this.status >= 500;
  }
}

export interface SendMessageInput {
  /** E.164 recipient. Required unless `conversationId` is set. */
  to?: string;
  /** Existing Linq chat id. Required unless `to` is set. */
  conversationId?: string;
  body: string;
  /**
   * Stable key so a retried send does not double-deliver. Goes inside the
   * `message` object, which is where Linq looks for it.
   */
  idempotencyKey?: string;
}

export interface ListChatsInput {
  limit?: number;
}

export interface ListMessagesInput {
  chatId: string;
  limit?: number;
}

export class LinqClient {
  /**
   * The API base and the key source are fixed, not injected. There is one
   * Linq deployment and one credential this client can use, so passing either
   * in would only create a way for a caller to be wrong. Tests exercise the
   * client by stubbing `fetch` and the credential module.
   */
  private readonly baseUrl = LINQ_API_BASE;
  private readonly getApiKey = resolveLinqApiKey;

  /**
   * `GET /phone_numbers`.
   *
   * Readiness uses this: a 200 with at least one line means the token works
   * and there is something to send from. An empty list is a configured
   * account with no line, which is not ready.
   */
  async listPhoneNumbers(): Promise<{ phoneNumber: string }[]> {
    const raw = await this.request("/phone_numbers", { method: "GET" });
    const parsed = ListPhoneNumbersResponseSchema.safeParse(raw);
    if (!parsed.success) {
      return [];
    }
    return parsed.data.phone_numbers
      .map((row) => row.phone_number)
      .filter((value): value is string => Boolean(value))
      .map((phoneNumber) => ({ phoneNumber }));
  }

  /**
   * `POST /messages` or `POST /chats/{id}/messages`.
   *
   * A bare handle goes to `/messages` with no `from`, so Linq picks the
   * sending line. A known chat id posts into that chat. Callers should
   * always pass `idempotencyKey`.
   */
  async sendMessage(input: SendMessageInput): Promise<LinqMessage | undefined> {
    if (!input.to && !input.conversationId) {
      throw new Error("sendMessage requires either `to` or `conversationId`");
    }

    const message = {
      parts: [{ type: "text", value: input.body }],
      ...(input.idempotencyKey
        ? { idempotency_key: input.idempotencyKey }
        : {}),
    };

    const raw = input.conversationId
      ? await this.request(
          `/chats/${encodeURIComponent(input.conversationId)}/messages`,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ message }),
          },
        )
      : await this.request("/messages", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            to: [input.to],
            message,
          }),
        });

    return SendMessageResponseSchema.safeParse(raw).data?.message;
  }

  /** `GET /chats`. */
  async listChats(input: ListChatsInput = {}): Promise<ListChatsResponse> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const query = params.toString();
    const raw = await this.request(`/chats${query ? `?${query}` : ""}`, {
      method: "GET",
    });
    const parsed = ListChatsResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : { chats: [] };
  }

  /** `GET /chats/{id}/messages`. */
  async listMessages(input: ListMessagesInput): Promise<ListMessagesResponse> {
    const params = new URLSearchParams();
    if (input.limit !== undefined) {
      params.set("limit", String(input.limit));
    }
    const query = params.toString();
    const raw = await this.request(
      `/chats/${encodeURIComponent(input.chatId)}/messages${query ? `?${query}` : ""}`,
      { method: "GET" },
    );
    const parsed = ListMessagesResponseSchema.safeParse(raw);
    return parsed.success ? parsed.data : { messages: [] };
  }

  /** `POST /chats/{id}/typing`. Best-effort; a 204 is success. */
  async startTyping(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/typing`, {
      method: "POST",
    });
  }

  /** `DELETE /chats/{id}/typing`. Best-effort; a 204 is success. */
  async stopTyping(chatId: string): Promise<void> {
    await this.request(`/chats/${encodeURIComponent(chatId)}/typing`, {
      method: "DELETE",
    });
  }

  /** `POST /webhook-subscriptions`. */
  async createWebhook(url: string): Promise<unknown> {
    return this.request("/webhook-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        target_url: url,
        subscribed_events: [...LINQ_WEBHOOK_EVENTS],
      }),
    });
  }

  /** `GET /webhook-subscriptions`. */
  async listWebhooks(): Promise<unknown> {
    return this.request("/webhook-subscriptions", { method: "GET" });
  }

  /** `PUT /webhook-subscriptions/{id}`. */
  async updateWebhook(
    id: string,
    update: { target_url?: string; subscribed_events?: string[] },
  ): Promise<unknown> {
    return this.request(`/webhook-subscriptions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(update),
    });
  }

  /**
   * `DELETE /webhook-subscriptions/{id}`.
   *
   * Used when an existing registration's signing secret was lost: Linq
   * issues one exactly once, so the only recovery is to replace it.
   */
  async deleteWebhook(id: string): Promise<void> {
    await this.request(`/webhook-subscriptions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    });
  }

  /**
   * One authenticated request, retrying 429s and 5xx with exponential backoff.
   *
   * The API key is resolved per request rather than cached, so a rotated key
   * takes effect without a restart. Empty 204 bodies parse as `{}`.
   */
  private async request(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const apiKey = await this.getApiKey();
    let lastError: LinqApiError | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (attempt > 0) {
        await sleep(BASE_BACKOFF_MS * 2 ** (attempt - 1));
      }

      let response: Response;
      try {
        response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          headers: {
            ...init.headers,
            Authorization: `Bearer ${apiKey}`,
          },
        });
      } catch (err) {
        throw new LinqApiError(
          `Linq API ${init.method ?? "GET"} ${path} could not be reached: ${describeError(err)}`,
          0,
        );
      }

      if (response.ok) {
        if (response.status === 204) {
          return {};
        }
        return await response.json().catch(() => ({}));
      }

      const body = await response.text().catch(() => undefined);
      lastError = new LinqApiError(
        describeApiFailure(
          `Linq API ${init.method ?? "GET"} ${path}`,
          response.status,
          body,
        ),
        response.status,
        body,
      );

      if (!lastError.retryable) {
        throw lastError;
      }
    }

    throw lastError ?? new LinqApiError("Linq API request failed", 0);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export type { LinqChat, LinqMessage };
