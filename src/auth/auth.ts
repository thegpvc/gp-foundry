/** Resolve the effective auth mode + secrets from config (shared by handlers + validate). */
import type { FoundryConfig } from "../ir/types.js";

export interface ResolvedAuth {
  mode: "app" | "pat" | "github-token";
  appIdSecret?: string;
  appKeySecret?: string;
  tokenSecret?: string;
}

export function resolveAuth(cfg: FoundryConfig): ResolvedAuth {
  const a = cfg.auth;
  if (a?.mode) {
    return {
      mode: a.mode,
      appIdSecret: a.app_id_secret ?? cfg.identity.app_id_secret,
      appKeySecret: a.app_key_secret ?? cfg.identity.app_key_secret,
      tokenSecret: a.token_secret,
    };
  }
  // Back-compat: identity App secrets imply App mode.
  if (cfg.identity.app_id_secret && cfg.identity.app_key_secret) {
    return {
      mode: "app",
      appIdSecret: cfg.identity.app_id_secret,
      appKeySecret: cfg.identity.app_key_secret,
    };
  }
  return { mode: "github-token" };
}
