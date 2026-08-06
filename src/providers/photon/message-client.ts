/**
 * The message plane, and the one place the Photon SDK is imported.
 *
 * Photon runs two planes with two protocols. The control plane
 * (`spectrum.photon.codes`) is ordinary REST — projects, tokens, webhooks —
 * and `client.ts` speaks it directly. The message plane is gRPC behind Envoy,
 * and nothing in this plugin is going to speak protobuf by hand, so the
 * vendor's SDK owns that half.
 *
 * Everything the SDK exposes is funnelled through the narrow surface below.
 * Two reasons:
 *
 * 1. **One import site.** `@photon-ai/advanced-imessage` pulls in `grpc-js`
 *    and a protobuf runtime. Confining it here keeps the rest of the plugin
 *    importable — and testable — without any of that.
 * 2. **A factory the tests can replace.** The SDK opens a real gRPC channel on
 *    construction, so a test that exercised the adapter against it would
 *    either dial the network or need a process-global module mock. Injecting
 *    the factory costs one parameter and avoids both.
 *
 * Only the three calls this channel makes are re-exported. The SDK's surface
 * is far larger — reactions, polls, stickers, live event streams — and it can
 * be widened here when something needs it.
 */

import { createGrpcClient } from "@photon-ai/advanced-imessage/grpc";
import type {
  CreateChatResult,
  Message,
  MessageListPage as SdkMessageListPage,
} from "@photon-ai/advanced-imessage/grpc";

/** A message as the plane reports it. The SDK's own type, unwrapped. */
export type PhotonMessage = Message;
export type MessageListPage = SdkMessageListPage;
export type PhotonChatResult = CreateChatResult;

export interface SendTextInput {
  chatGuid: string;
  text: string;
  /** Stable key so a retried send does not double-deliver. */
  clientMessageId: string;
}

export interface CreateChatInput {
  addresses: string[];
  clientMessageId: string;
  /** Sent in the same round trip as the chat resolution when present. */
  text?: string;
}

export interface ListRecentInput {
  /** Lower bound. The plane returns messages created after it. */
  after?: Date;
  limit: number;
  /** `false` asks for incoming only, which is all this plugin wants. */
  isFromMe?: boolean;
}

/** What Photon knows about an address, and how it can be reached. */
export interface AddressReport {
  address: string;
  country: string | null;
  /** `iMessage`, `SMS`, `RCS`, `unknown` — whatever the server reports. */
  services: readonly string[];
}

/** What this plugin asks of the message plane. */
export interface MessageClient {
  sendText(input: SendTextInput): Promise<PhotonMessage>;
  createChat(input: CreateChatInput): Promise<PhotonChatResult>;
  listRecent(input: ListRecentInput): Promise<MessageListPage>;
  /**
   * What Photon makes of an address.
   *
   * Diagnostic only — nothing sends through it. It exists because Photon
   * refuses a recipient with "Target not allowed for this project", a sentence
   * that is equally consistent with a missing user record, a handle Photon
   * cannot reach over iMessage, and a bug on their side. Asking Photon
   * directly is what separates those three, and every round of guessing at it
   * from the outside has cost more than the call does.
   */
  describeAddress(address: string): Promise<AddressReport>;
  /** Release the gRPC channel. Called on provider shutdown. */
  close(): Promise<void>;
}

export interface MessageClientOptions {
  /** Resolved per call, so a rotated token is picked up without a reconnect. */
  token: () => Promise<string>;
  address?: string;
}

export type MessageClientFactory = (
  opts: MessageClientOptions,
) => MessageClient;

/** The plane rejects a page size outside `1..100`. */
const MAX_PAGE_SIZE = 100;

/** Default gRPC address. Envoy terminates TLS on 443. */
export const PHOTON_IMESSAGE_ADDRESS = "imessage.spectrum.photon.codes:443";

/**
 * The real client.
 *
 * `token` is handed over as the SDK's async token function rather than a
 * string: the plane's tokens are short-lived, and resolving per call lets the
 * caller's own cache decide when to mint a new one. A long-lived channel
 * therefore survives a token rotation without being rebuilt.
 */
export const createMessageClient: MessageClientFactory = (opts) => {
  const im = createGrpcClient({
    address: opts.address ?? PHOTON_IMESSAGE_ADDRESS,
    tls: true,
    token: opts.token,
    // The SDK's own idempotency header, on top of the `clientMessageId` each
    // call already carries. A retried send must not reach the phone twice.
    autoIdempotency: true,
  });

  return {
    sendText: (input) =>
      im.messages.sendText(input.chatGuid, input.text, {
        clientMessageId: input.clientMessageId,
      }),

    createChat: (input) =>
      im.chats.create(input.addresses, {
        clientMessageId: input.clientMessageId,
        ...(input.text === undefined ? {} : { message: input.text }),
      }),

    listRecent: (input) =>
      im.messages.listRecent({
        pageSize: Math.min(input.limit, MAX_PAGE_SIZE),
        ...(input.after ? { after: input.after } : {}),
        ...(input.isFromMe === undefined ? {} : { isFromMe: input.isFromMe }),
      }),

    async describeAddress(address) {
      const info = await im.addresses.get(address);
      return {
        address: info.address,
        country: info.country,
        services: info.services,
      };
    },

    close: () => im.close(),
  };
};
