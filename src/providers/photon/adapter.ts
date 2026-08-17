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
     * Register, or re-register when the signing secret is gone.
     *
     * Photon returns the secret exactly once, at creation, and its listing
     * never carries it. So a registration that exists while this plugin holds
     * no secret is worse than none: deliveries arrive and nothing can verify
     * them. Deleting and recreating is the only way back to a verifiable
     * webhook, and Photon's own docs say the same.
     *
     * Matching ignores a trailing slash — see {@link sameWebhookUrl}. Without
     * that, a registration stored as `events-photon/` reads as a different
     * address, so it is neither reused nor deleted: this creates a second one
     * beside it, both deliver, and only the newer secret verifies.
     */
    async ensureWebhook(
      opts: EnsureWebhookOptions,
    ): Promise<WebhookRegistration> {
      const existing = pickWebhookRegistration(
        await client.listWebhooks(),
        opts.url,
        (hook) => hook.webhookUrl,
      );

      if (existing && opts.hasSecret) {
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

      // A handle with no chat resolved yet. Two things have to happen before
      // a chat exists, and they are easy to confuse: Photon will only message
      // people the project knows, so the recipient is registered as a user
      // first. Skipping it fails at the message plane with "Target not allowed
      // for this project", which sounds like a bad address rather than a
      // provisioning step nobody took.
      //
      // Registration is on the cold path only, and the guid cache below means
      // that path runs once per handle — so this is not a call per message.
      // Setup also calls this via `allowRecipient` so a first send is not the
      // first time Photon hears the number.
      await allowHandle(addressed);

      // Then create-or-resolve the chat, carrying the opening message rather
      // than paying two round trips.
      let created;
      try {
        created = await client.createChat({
          addresses: [addressed],
          clientMessageId: sendOpts.idempotencyKey,
          text: body,
        });
      } catch (err) {
        // The user record was just written, so a refusal here is not the
        // missing registration it sounds like. Ask Photon what it makes of
        // the address and say that instead of guessing.
        if (isTargetRefusal(err)) await explainRefusal(client, addressed, err);
        throw err;
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
