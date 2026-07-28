/**
 * `send_imessage` — send a text message to a phone number.
 *
 * The outbound half of the channel, reachable before the host's inbound
 * pipeline exists. It is also how outbound gets exercised end to end: the tool
 * goes through the channel transport, so a send here proves the same path a
 * real reply will take.
 *
 * High risk on purpose. This sends a real SMS or iMessage to a real phone,
 * which is outward-facing and not undoable, so it should prompt rather than
 * auto-approve.
 */

import type { ToolDefinition, ToolExecutionResult } from "@vellumai/plugin-api";
import { RiskLevel } from "@vellumai/plugin-api";

import { sendMessage } from "../src/send.ts";

const sendIMessage: ToolDefinition = {
  name: "send_imessage",
  description:
    "Send a text message (iMessage or SMS) to a phone number through the assistant's iMessage channel. " +
    "The recipient must be given in E.164 form, e.g. +15551234567. " +
    "Markdown is flattened before sending because message bubbles do not render it.",
  input_schema: {
    type: "object",
    properties: {
      to: {
        type: "string",
        description: "Recipient phone number in E.164 form, e.g. +15551234567.",
      },
      body: {
        type: "string",
        description: "Message text to send.",
      },
    },
    required: ["to", "body"],
    additionalProperties: false,
  },
  defaultRiskLevel: RiskLevel.High,
  category: "messaging",

  async execute(
    input: Record<string, unknown>,
  ): Promise<ToolExecutionResult> {
    const to = typeof input.to === "string" ? input.to : "";
    const body = typeof input.body === "string" ? input.body : "";

    if (!to) {
      return { content: "Error: `to` is required.", isError: true };
    }

    const result = await sendMessage(to, body);
    if (!result.ok) {
      return { content: `Error: ${result.error}`, isError: true };
    }

    return {
      content: result.externalMessageId
        ? `Sent to ${result.to} (message ${result.externalMessageId}).`
        : `Sent to ${result.to}.`,
      isError: false,
    };
  },
};

export default sendIMessage;
