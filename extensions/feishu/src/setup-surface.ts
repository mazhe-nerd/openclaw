import {
  createTopLevelChannelAllowFromSetter,
  createTopLevelChannelDmPolicy,
  createTopLevelChannelGroupPolicySetter,
  createTopLevelChannelParsedAllowFromPrompt,
  DEFAULT_ACCOUNT_ID,
  formatDocsLink,
  hasConfiguredSecretInput,
  mergeAllowFromEntries,
  patchTopLevelChannelConfigSection,
  promptSingleChannelSecretInput,
  splitSetupEntries,
  type ChannelSetupDmPolicy,
  type ChannelSetupWizard,
  type OpenClawConfig,
  type SecretInput,
} from "openclaw/plugin-sdk/setup";
import { inspectFeishuCredentials } from "./accounts.js";
import {
  beginAppRegistration,
  getAppOwnerOpenId,
  initAppRegistration,
  pollAppRegistration,
  printQrCode,
  type AppRegistrationResult,
} from "./app-registration.js";
import { probeFeishu } from "./probe.js";
import type { FeishuAppMode, FeishuConfig, FeishuDomain } from "./types.js";

const channel = "feishu" as const;
const setFeishuAllowFrom = createTopLevelChannelAllowFromSetter({
  channel,
});
const setFeishuGroupPolicy = createTopLevelChannelGroupPolicySetter({
  channel,
  enabled: true,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function isFeishuConfigured(cfg: OpenClawConfig): boolean {
  const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;

  const isAppIdConfigured = (value: unknown): boolean => {
    const asString = normalizeString(value);
    if (asString) {
      return true;
    }
    if (!value || typeof value !== "object") {
      return false;
    }
    const rec = value as Record<string, unknown>;
    const source = normalizeString(rec.source)?.toLowerCase();
    const id = normalizeString(rec.id);
    if (source === "env" && id) {
      return Boolean(normalizeString(process.env[id]));
    }
    return hasConfiguredSecretInput(value);
  };

  const topLevelConfigured = Boolean(
    isAppIdConfigured(feishuCfg?.appId) && hasConfiguredSecretInput(feishuCfg?.appSecret),
  );

  const accountConfigured = Object.values(feishuCfg?.accounts ?? {}).some((account) => {
    if (!account || typeof account !== "object") {
      return false;
    }
    const hasOwnAppId = Object.prototype.hasOwnProperty.call(account, "appId");
    const hasOwnAppSecret = Object.prototype.hasOwnProperty.call(account, "appSecret");
    const accountAppIdConfigured = hasOwnAppId
      ? isAppIdConfigured((account as Record<string, unknown>).appId)
      : isAppIdConfigured(feishuCfg?.appId);
    const accountSecretConfigured = hasOwnAppSecret
      ? hasConfiguredSecretInput((account as Record<string, unknown>).appSecret)
      : hasConfiguredSecretInput(feishuCfg?.appSecret);
    return Boolean(accountAppIdConfigured && accountSecretConfigured);
  });

  return topLevelConfigured || accountConfigured;
}

function setFeishuGroupSenderAllowFrom(
  cfg: OpenClawConfig,
  groupSenderAllowFrom: string[],
): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groupSenderAllowFrom,
      },
    },
  };
}

const promptFeishuAllowFrom = createTopLevelChannelParsedAllowFromPrompt({
  channel,
  defaultAccountId: DEFAULT_ACCOUNT_ID,
  noteTitle: "Feishu allowlist",
  noteLines: [
    "Allowlist Feishu DMs by open_id or user_id.",
    "You can find user open_id in Feishu admin console or via API.",
    "Examples:",
    "- ou_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    "- on_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
  ],
  message: "Feishu allowFrom (user open_ids)",
  placeholder: "ou_xxxxx, ou_yyyyy",
  parseEntries: (raw) => ({ entries: splitSetupEntries(raw) }),
  mergeEntries: ({ existing, parsed }) => mergeAllowFromEntries(existing, parsed),
});

async function noteFeishuCredentialHelp(
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"],
): Promise<void> {
  await prompter.note(
    [
      "1) Go to Feishu Open Platform (open.feishu.cn)",
      "2) Create a self-built app",
      "3) Get App ID and App Secret from Credentials page",
      "4) Enable required permissions: im:message, im:chat, contact:user.base:readonly",
      "5) Publish the app or add it to a test group",
      "Tip: you can also set FEISHU_APP_ID / FEISHU_APP_SECRET env vars.",
      `Docs: ${formatDocsLink("/channels/feishu", "feishu")}`,
    ].join("\n"),
    "Feishu credentials",
  );
}

async function promptFeishuAppId(params: {
  prompter: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];
  initialValue?: string;
}): Promise<string> {
  return String(
    await params.prompter.text({
      message: "Enter Feishu App ID",
      initialValue: params.initialValue,
      validate: (value) => (value?.trim() ? undefined : "Required"),
    }),
  ).trim();
}

const feishuDmPolicy: ChannelSetupDmPolicy = createTopLevelChannelDmPolicy({
  label: "Feishu",
  channel,
  policyKey: "channels.feishu.dmPolicy",
  allowFromKey: "channels.feishu.allowFrom",
  getCurrent: (cfg) => (cfg.channels?.feishu as FeishuConfig | undefined)?.dmPolicy ?? "pairing",
  promptAllowFrom: promptFeishuAllowFrom,
});

type WizardPrompter = Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["prompter"];

// ---------------------------------------------------------------------------
// Security policy helpers
// ---------------------------------------------------------------------------

function applyNewAppSecurityPolicy(
  cfg: OpenClawConfig,
  openId: string | undefined,
): OpenClawConfig {
  let next = cfg;

  if (!openId) {
    return next;
  }

  // dmPolicy=allowlist, allowFrom=[openId]
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    patch: { dmPolicy: "allowlist" },
  });
  next = setFeishuAllowFrom(next, [openId]);

  // groupPolicy=open
  next = setFeishuGroupPolicy(next, "open");

  return next;
}

// ---------------------------------------------------------------------------
// Scan-to-create flow
// ---------------------------------------------------------------------------

async function runScanToCreate(prompter: WizardPrompter): Promise<AppRegistrationResult | null> {
  try {
    await initAppRegistration("feishu");
  } catch {
    await prompter.note(
      "Scan-to-create is not available in this environment. Falling back to manual input.",
      "Feishu setup",
    );
    return null;
  }

  const begin = await beginAppRegistration("feishu");

  await prompter.note("Scan the QR with Lark/Feishu on your phone.", "Feishu scan-to-create");
  await printQrCode(begin.qrUrl);

  const progress = prompter.progress("Fetching configuration results...");

  const outcome = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain: "feishu",
    tp: "ob_app",
  });

  switch (outcome.status) {
    case "success":
      progress.stop("Scan completed.");
      return outcome.result;
    case "access_denied":
      progress.stop("User denied authorization. Falling back to manual input.");
      return null;
    case "expired":
      progress.stop("Session expired. Falling back to manual input.");
      return null;
    case "timeout":
      progress.stop("Scan timed out. Falling back to manual input.");
      return null;
    case "error":
      progress.stop(`Registration error: ${outcome.message}. Falling back to manual input.`);
      return null;
  }
}

// ---------------------------------------------------------------------------
// New app configuration flow
// ---------------------------------------------------------------------------

async function runNewAppFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig }> {
  const { prompter, options } = params;
  let next = params.cfg;

  // ----- QR scan flow -----
  let appId: string | null = null;
  let appSecret: SecretInput | null = null;
  let appSecretProbeValue: string | null = null;
  let scanDomain: FeishuDomain | undefined;
  let scanOpenId: string | undefined;

  const scanResult = await runScanToCreate(prompter);
  if (scanResult) {
    appId = scanResult.appId;
    appSecret = scanResult.appSecret;
    appSecretProbeValue = scanResult.appSecret;
    scanDomain = scanResult.domain;
    scanOpenId = scanResult.openId;
  } else {
    // Fallback to manual input: collect domain, appId, appSecret.
    const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;
    await noteFeishuCredentialHelp(prompter);

    // Domain selection first (needed for API calls).
    const currentDomain = feishuCfg?.domain ?? "feishu";
    const domain = (await prompter.select({
      message: "Which Feishu domain?",
      options: [
        { value: "feishu", label: "Feishu (feishu.cn) - China" },
        { value: "lark", label: "Lark (larksuite.com) - International" },
      ],
      initialValue: currentDomain,
    })) as FeishuDomain;
    scanDomain = domain;

    appId = await promptFeishuAppId({
      prompter,
      initialValue: normalizeString(process.env.FEISHU_APP_ID),
    });

    const appSecretResult = await promptSingleChannelSecretInput({
      cfg: next,
      prompter,
      providerHint: "feishu",
      credentialLabel: "App Secret",
      secretInputMode: options?.secretInputMode,
      accountConfigured: false,
      canUseEnv: false,
      hasConfigToken: false,
      envPrompt: "",
      keepPrompt: "Feishu App Secret already configured. Keep it?",
      inputPrompt: "Enter Feishu App Secret",
      preferredEnvVar: "FEISHU_APP_SECRET",
    });
    if (appSecretResult.action === "set") {
      appSecret = appSecretResult.value;
      appSecretProbeValue = appSecretResult.resolvedValue;
    }

    // Fetch openId via API for manual flow.
    if (appId && appSecretProbeValue) {
      scanOpenId = await getAppOwnerOpenId({
        appId,
        appSecret: appSecretProbeValue,
        domain: scanDomain,
      });
    }
  }

  // ----- Apply credentials & security policy -----
  const configProgress = prompter.progress("Configuring...");
  await new Promise((resolve) => setTimeout(resolve, 50));

  if (appId && appSecret) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      enabled: true,
      patch: {
        appId,
        appSecret,
        connectionMode: "websocket",
        ...(scanDomain ? { domain: scanDomain } : {}),
      },
    });
  }

  if (scanDomain) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      patch: { domain: scanDomain },
    });
  }

  next = applyNewAppSecurityPolicy(next, scanOpenId);

  // Always set appMode to bot.
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    enabled: true,
    patch: { appMode: "bot" },
  });

  configProgress.stop("Bot configured.");

  return { cfg: next };
}

// ---------------------------------------------------------------------------
// Edit configuration flow — security policy recommendation
// ---------------------------------------------------------------------------

async function recommendSecurityPolicyChanges(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  appId: string;
  appSecret: string | undefined;
  domain: FeishuDomain | undefined;
}): Promise<OpenClawConfig> {
  const { prompter } = params;
  let next = params.cfg;
  const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;

  const currentDmPolicy = feishuCfg?.dmPolicy ?? "pairing";
  const currentGroupPolicy = feishuCfg?.groupPolicy ?? "allowlist";

  const needDmRecommendation = currentDmPolicy === "open";
  const needGroupRecommendation = currentGroupPolicy === "open";

  if (!needDmRecommendation && !needGroupRecommendation) {
    return next;
  }

  // Try to get owner open_id.
  let ownerOpenId: string | undefined;
  if (params.appSecret) {
    ownerOpenId = await getAppOwnerOpenId({
      appId: params.appId,
      appSecret: params.appSecret,
      domain: params.domain,
    });
  }

  await prompter.note(
    "To keep your data safe while acting as you, we suggest these policy updates:",
    "Security recommendation",
  );

  const recommendations: string[] = [];
  let dmPatch: Partial<FeishuConfig> = {};
  let dmAllowFrom: string[] | undefined;
  let groupPatch: Partial<FeishuConfig> = {};
  let groupSenderAllowFrom: string[] | undefined;

  if (needDmRecommendation) {
    if (ownerOpenId) {
      dmPatch = { dmPolicy: "allowlist" };
      dmAllowFrom = [ownerOpenId];
      recommendations.push("- DMs: Only the owner");
    } else {
      dmPatch = { dmPolicy: "pairing" };
      recommendations.push("- DMs: Only the paired user");
    }
  }

  if (needGroupRecommendation) {
    if (ownerOpenId) {
      groupSenderAllowFrom = [ownerOpenId];
      recommendations.push("- Group chats: Only when mentioned by the owner");
    } else {
      groupPatch = { groupPolicy: "disabled" };
      recommendations.push("- Group chats: Disabled");
    }
  }

  for (const rec of recommendations) {
    await prompter.note(rec, "");
  }

  const apply = await prompter.confirm({
    message: "Apply?",
    initialValue: true,
  });

  if (!apply) {
    return next;
  }

  // Apply recommendations.
  if (Object.keys(dmPatch).length > 0) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      patch: dmPatch,
    });
  }
  if (dmAllowFrom) {
    next = setFeishuAllowFrom(next, dmAllowFrom);
  }
  if (Object.keys(groupPatch).length > 0) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      patch: groupPatch,
    });
  }
  if (groupSenderAllowFrom) {
    next = setFeishuGroupSenderAllowFrom(next, groupSenderAllowFrom);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Edit configuration flow
// ---------------------------------------------------------------------------

async function runEditFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
}): Promise<{ cfg: OpenClawConfig } | null> {
  const { prompter, options } = params;
  let next = params.cfg;
  const feishuCfg = next.channels?.feishu as FeishuConfig | undefined;

  // Check existing appId.
  const existingAppId = normalizeString(feishuCfg?.appId);
  if (existingAppId) {
    const useExisting = await prompter.confirm({
      message: `We found an existing bot (App ID: ${existingAppId}). Use it for this setup?`,
      initialValue: true,
    });

    if (useExisting) {
      // Step 3: Check current appMode for security recommendations.
      const currentAppMode = (feishuCfg as Record<string, unknown> | undefined)?.appMode as
        | FeishuAppMode
        | undefined;

      if (currentAppMode !== "user") {
        // Bot mode (or unset) — skip to last step.
      } else {
        // User mode — recommend security policy changes.
        const resolvedSecret = inspectFeishuCredentials(feishuCfg);
        next = await recommendSecurityPolicyChanges({
          cfg: next,
          prompter,
          appId: existingAppId,
          appSecret: resolvedSecret?.appSecret,
          domain: resolvedSecret?.domain,
        });
      }
    } else {
      // Step 4: User wants a new bot — run new app flow.
      return runNewAppFlow({ cfg: next, prompter, options });
    }
  } else {
    // No existing appId — run new app flow.
    return runNewAppFlow({ cfg: next, prompter, options });
  }

  await prompter.note("Bot configured.", "");

  return { cfg: next };
}

// ---------------------------------------------------------------------------
// Standalone login entry point (for `channels login --channel feishu`)
// ---------------------------------------------------------------------------

export async function runFeishuLogin(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
}): Promise<OpenClawConfig> {
  const { cfg, prompter } = params;
  const options = {};
  const alreadyConfigured = isFeishuConfigured(cfg);

  if (alreadyConfigured) {
    const result = await runEditFlow({ cfg, prompter, options });
    if (result === null) {
      return cfg;
    }
    return result.cfg;
  }

  const result = await runNewAppFlow({ cfg, prompter, options });
  return result.cfg;
}

// ---------------------------------------------------------------------------
// Exported wizard
// ---------------------------------------------------------------------------

export { feishuSetupAdapter } from "./setup-core.js";

export const feishuSetupWizard: ChannelSetupWizard = {
  channel,
  resolveAccountIdForConfigure: () => DEFAULT_ACCOUNT_ID,
  resolveShouldPromptAccountIds: () => false,
  status: {
    configuredLabel: "configured",
    unconfiguredLabel: "needs app credentials",
    configuredHint: "configured",
    unconfiguredHint: "needs app creds",
    configuredScore: 2,
    unconfiguredScore: 0,
    resolveConfigured: ({ cfg }) => isFeishuConfigured(cfg),
    resolveStatusLines: async ({ cfg, configured }) => {
      const feishuCfg = cfg.channels?.feishu as FeishuConfig | undefined;
      const resolvedCredentials = inspectFeishuCredentials(feishuCfg);
      let probeResult = null;
      if (configured && resolvedCredentials) {
        try {
          probeResult = await probeFeishu(resolvedCredentials);
        } catch {}
      }
      if (!configured) {
        return ["Feishu: needs app credentials"];
      }
      if (probeResult?.ok) {
        return [`Feishu: connected as ${probeResult.botName ?? probeResult.botOpenId ?? "bot"}`];
      }
      return ["Feishu: configured (connection not verified)"];
    },
  },

  // -------------------------------------------------------------------------
  // prepare: determine flow based on existing configuration
  // -------------------------------------------------------------------------
  prepare: async ({ cfg, credentialValues }) => {
    const alreadyConfigured = isFeishuConfigured(cfg);

    if (alreadyConfigured) {
      return {
        credentialValues: { ...credentialValues, _flow: "edit" },
      };
    }

    return {
      credentialValues: { ...credentialValues, _flow: "new" },
    };
  },

  credentials: [],

  // -------------------------------------------------------------------------
  // finalize: run the appropriate flow
  // -------------------------------------------------------------------------
  finalize: async ({ cfg, prompter, options, credentialValues }) => {
    const flow = credentialValues._flow ?? "new";

    if (flow === "edit") {
      const result = await runEditFlow({ cfg, prompter, options });
      if (result === null) {
        return { cfg };
      }
      return result;
    }

    return runNewAppFlow({ cfg, prompter, options });
  },

  dmPolicy: feishuDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};
