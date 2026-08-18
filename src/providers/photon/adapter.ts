/**
 * BYO provider — the user's own Photon (Spectrum) project.
 *
 * Everything Photon-specific lives behind this adapter: the two-plane client,
 * the tolerant schemas, and the normalizer. Nothing above the provider seam
 * imports from this directory.
 *
 * The one shape difference worth knowing from outside: Photon addresses a
 * conversation by chat guid (`any;-;+15551234567`), not by phone number. A
 * reply already has one — the webhook's space id is that guid — so the common
 * path costs nothing. Only a cold send to a bare handle has to resolve a chat
 * first, and that resolution carries the message with it.
 */

import { PhotonClient } from "./client.ts";
import type { MessageClientFactory } from "./message-client.ts";
import { classifyPhotonWebhook, normalizePhotonMessage } from "./normalize.ts";
import type {
  EnsureWebhookOptions,
  FetchInboundOptions,
  InboundRecord,
  LiveInboundSubscription,
  MessagingProvider,
  SendResult,
  SendTarget,
  WebhookDelivery,
  WebhookRegistration,
} from "../types.ts";
import { phoneFromAddress } from "../../channel/identity.ts";
import { pickWebhookRegistration } from "../../webhook-endpoint.ts";

/** A chat guid, as opposed to a handle we would have to resolve one for. */
function isChatGuid(value: string): boolean {
  return value.includes(";");
}

/**
 * Photon's refusal to message someone, as distinct from a transport failure.
 *
 * Matched on the sentence because the plane reports it as an ordinary error
 * rather than a distinguishable code. Loose on purpose: a near-miss costs one
 * diagnostic call, while missing it costs another round of guessing.
 */
function isTargetRefusal(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /target .*not allowed|not allowed for this project/i.test(message);
}

/**
 * Re-throw a refusal with what Photon itself knows about the address.
 *
 * "Target not allowed for this project" is equally consistent with three very
 * different causes: the user record is missing, the handle is not reachable
 * over iMessage at all, or something is wrong on Photon's side. Every attempt
 * to tell them apart from the outside has produced a new theory and no
 * evidence, so this asks Photon directly and puts the answer in the error.
 *
 * `services` is the load-bearing part. An address Photon reports as reachable
 * over iMessage, refused anyway, is a Photon-side problem and the report says
 * so. An address it reports no iMessage service for was never deliverable on
 * an iMessage line, whatever the user record says.
 */
async function explainRefusal(
  client: PhotonClient,
  address: string,
  err: unknown,
): Promise<never> {
  const reason = err instanceof Error ? err.message : String(err);
  try {
    const report = await client.describeAddress(address);
    const services = report.services.length
      ? report.services.join(", ")
      : "none";
    throw new Error(
      `Photon refused ${address}: ${reason}. Photon reports that address as ` +
        `${report.address} (country ${report.country ?? "unknown"}) with ` +
        `services: ${services}. A project user exists for it, so if iMessage ` +
        `is listed here the refusal is Photon-side; if it is not, the handle ` +
        `is not reachable on an iMessage line.`,
    );
  } catch (probeErr) {
    // The probe is best-effort. Losing the original refusal to a failure in
    // the thing meant to explain it would be the worst outcome of all.
    if (probeErr instanceof Error && probeErr.message.startsWith("Photon refused")) {
      throw probeErr;
    }
    throw new Error(
      `Photon refused ${address}: ${reason}. Asking Photon about that ` +
        `address also failed (${probeErr instanceof Error ? probeErr.message : String(probeErr)}).`,
    );
  }
}

export function createPhotonProvider(
  /** Injected by tests so a send never opens a real gRPC channel. */
  makeMessageClient?: MessageClientFactory,
): MessagingProvider {
  const client = new PhotonClient(makeMessageClient);

  /**
   * Chat guids resolved for a bare handle, for this provider's lifetime.
   *
   * A long reply is several sends to the same recipient — the skill script and
   * the transport both chunk — and without this each chunk would re-resolve
   * the same chat before it could go out. Same reasoning as the client's token
   * cache: a guid is stable for a set of participants, and a wrong one
   * surfaces immediately as a failed send rather than as a silent misdelivery.
   */
  const chatGuids = new Map<string, string>();

  /**
   * Register a handle as a Photon user, or throw with what to type instead.
   *
   * Shared by the public `allowRecipient` and the cold-send path so a number
   * allowed during setup and a number first seen on send go through the same
   * call. Chat guids are reduced to the phone they carry: Photon's user API
   * wants E.164, and posting the guid is a 422 that reads like a bad address.
   */
  async function allowHandle(handle: string): Promise<string> {
    const phone = phoneFromAddress(handle);
    if (!phone) {
      throw new Error(
        `"${handle}" is not a phone number Photon can allow. ` +
          "Use E.164, e.g. +15551234567.",
      );
    }
    await client.ensureUser(phone);
    return phone;
  }

  return {
    id: "photon",
    label: "Photon (your own project)",
    supportsPolling: true,
    supportsLive: true,

    /**
     * Both credentials plus a live control-plane call.
     *
     * Stopping at "the credentials are stored" would report ready for a
     * project id that was mistyped, and the first symptom would be a silently
     * dead line. `getProject` is the cheapest call that proves the pair works.
     */
    async checkReadiness() {
      try {
        await client.getProject();
        return { ready: true as const };
      } catch (err) {
        return {
          ready: false as const,
          reason: err instanceof Error ? err.message : String(err),
        };
      }
    },

    async fetchInbound(
      fetchOpts: FetchInboundOptions,
    ): Promise<InboundRecord[]> {
      const response = await client.listRecent({
        ...(fetchOpts.since ? { after: new Date(fetchOpts.since) } : {}),
        limit: fetchOpts.limit,
        isFromMe: false,
      });

      return response.messages.map((message) => ({
        id: message.guid,
        // The cursor is stored as a string; the SDK decodes protobuf
        // timestamps into `Date`, so this is where the two meet.
        createdAt: message.dateCreated.toISOString(),
        // Normalizing here, inside the adapter, is what keeps the poller
        // provider-agnostic: it never sees a Photon-shaped payload.
        event: normalizePhotonMessage(message, new Date().toISOString()),
      }));
    },

    /**
     * Inbound over the gRPC channel this adapter already holds for send.
     *
     * Only `message.received` is yielded. Reads, edits, and tapbacks are
     * skipped here rather than turned into empty records: they are not turns
     * and they are not going to reappear as `message.received` later, so
     * there is nothing to dedupe. A received message that is not a turn
     * (ours, a tapback, no text) still yields a record so the live ingress
     * can remember its id.
     */
    subscribeInbound(): LiveInboundSubscription {
      const stream = client.subscribeEvents();
      const records = (async function* (): AsyncGenerator<InboundRecord> {
        for await (const liveEvent of stream) {
          const message = liveEvent.message;
          if (liveEvent.type !== "message.received" || !message) {
            continue;
          }
          yield {
            id: message.guid,
            createdAt: message.dateCreated.toISOString(),
            event: normalizePhotonMessage(message, new Date().toISOString()),
          };
        }
      })();
      return {
        [Symbol.asyncIterator]: () => records,
        close: () => stream.close(),
      };
    },

    /**
     * Register, or re-register when the signing secret is gone or the stored
     * URL is the slashless spelling.
     *
     * Photon returns the secret exactly once, at creation, and its listing
     * never carries it. So a registration that exists while this plugin holds
     * no secret is worse than none: deliveries arrive and nothing can verify
     * them. Deleting and recreating is the only way back to a verifiable
     * webhook, and Photon's own docs say the same.
     *
     * Matching still finds a slashless twin (`sameWebhookUrl`), but reuse
     * requires the exact spelling. A slashless URL 301s at Vellum's managed
     * gateway onto a trailing slash, and that redirect 404s a POST before
     * HMAC. Recreating is what moves Photon onto the canonical URL.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const existing = pickWebhookRegistration(
        await client.listWebhooks(),
        opts.url,
        (hook) => hook.webhookUrl,
      );

      // Reuse only the exact spelling. A slashless registration is the same
      // resource to us (`sameWebhookUrl`) but not to the managed gateway:
      // Photon POSTs the URL it stored, Vellum 301s that to a trailing slash,
      // and a POST that became a GET 404s before HMAC. Recreating points
      // Photon at the canonical URL even when we already hold a secret.
      const stored = existing?.webhookUrl?.trim();
      if (existing && opts.hasSecret && stored === opts.url.trim()) {
        return { created: false, id: existing.id };
      }
      if (existing?.id) {
        await client.deleteWebhook(existing.id);
      }

      const created = await client.createWebhook(opts.url);
      return {
        created: true,
        id: created?.id,
        secret: created?.signingSecret,
      };
    },

    /**
     * Send, resolving a chat first only when the target is a bare handle.
     *
     * `idempotencyKey` rides as `clientMessageId` and as the
     * `x-idempotency-key` header, so a retry after a timeout does not deliver
     * twice — on a real phone line the recipient sees both.
     */
    async setTyping(target: SendTarget, isTyping: boolean): Promise<void> {
      const addressed =
        "conversationId" in target ? target.conversationId : target.to;
      const known = isChatGuid(addressed)
        ? addressed
        : chatGuids.get(addressed);
      if (!known) {
        // No chat to type in yet. Creating one just to show dots would be
        // the first Photon hears of this number, which is a send's job.
        return;
      }
      await client.setTyping(known, isTyping);
    },

    async send(
      target: SendTarget,
      body: string,
      sendOpts: { idempotencyKey: string },
    ): Promise<SendResult> {
      const addressed =
        "conversationId" in target ? target.conversationId : target.to;
      const known = isChatGuid(addressed)
        ? addressed
        : chatGuids.get(addressed);

      if (known) {
        const message = await client.sendText({
          chatGuid: known,
          text: body,
          clientMessageId: sendOpts.idempotencyKey,
        });
        return { id: message?.guid };
      }

      // A handle with no chat resolved yet. `createChat` is enough when the
      // project already knows the recipient — the common case after setup,
      // and the path a direct SDK call takes. `POST /users/` used to run
      // first, unconditionally, and a failure there blocked the send even
      // when the message plane would have delivered.
      //
      // Registration is the recovery for "Target not allowed", not a
      // prerequisite. Setup still calls `allowRecipient` so a first send is
      // usually not the first time Photon hears the number.
      let created;
      try {
        created = await client.createChat({
          addresses: [addressed],
          clientMessageId: sendOpts.idempotencyKey,
          text: body,
        });
      } catch (err) {
        if (!isTargetRefusal(err)) throw err;
        try {
          await allowHandle(addressed);
        } catch (allowErr) {
          const refusal = err instanceof Error ? err.message : String(err);
          const allow = allowErr instanceof Error ? allowErr.message : String(allowErr);
          throw new Error(
            `Photon refused ${addressed}: ${refusal}. ` +
              `Registering that handle as a project user also failed (${allow}).`,
          );
        }
        try {
          created = await client.createChat({
            addresses: [addressed],
            clientMessageId: sendOpts.idempotencyKey,
            text: body,
          });
        } catch (retryErr) {
          if (isTargetRefusal(retryErr)) {
            await explainRefusal(client, addressed, retryErr);
          }
          throw retryErr;
        }
      }
      if (created.chatGuid) chatGuids.set(addressed, created.chatGuid);

      if (created.message) return { id: created.message.guid };

      // The chat resolved but carried no message back. Send explicitly rather
      // than reporting a delivery that may not have happened.
      if (created.chatGuid) {
        const message = await client.sendText({
          chatGuid: created.chatGuid,
          text: body,
          clientMessageId: sendOpts.idempotencyKey,
        });
        return { id: message?.guid };
      }

      throw new Error(
        `Photon could not resolve a chat for ${addressed}, so the message was not sent`,
      );
    },

    classifyWebhook(raw: unknown, receivedAt: string): WebhookDelivery {
      return classifyPhotonWebhook(raw, receivedAt);
    },

    async allowRecipient(handle: string): Promise<{ phoneNumber: string }> {
      return { phoneNumber: await allowHandle(handle) };
    },

    async close(): Promise<void> {
      chatGuids.clear();
      await client.close();
    },
  };
}
