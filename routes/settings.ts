/**
 * Settings routes for the config app, under `/x/plugins/imessage/settings`:
 *   GET   returns the current resolved settings
 *   PATCH applies a partial update and restarts ingress, returns the new view
 */

import { handleSettingsGet, handleSettingsPatch } from "../src/app-routes.ts";

export async function GET(_request: Request): Promise<Response> {
  return handleSettingsGet();
}

export async function PATCH(request: Request): Promise<Response> {
  return handleSettingsPatch(request);
}
