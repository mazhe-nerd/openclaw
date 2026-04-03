import {
  buildSingleChannelSecretPromptState,
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
import { inspectFeishuCredentials, listFeishuAccountIds } from "./accounts.js";
import {
  beginAppRegistration,
  getAppOwnerOpenId,
  initAppRegistration,
  pollAppRegistration,
  printQrCode,
  type AppRegistrationResult,
} from "./app-registration.js";
import { probeFeishu } from "./probe.js";
import { feishuSetupAdapter } from "./setup-core.js";
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
// Skills lists (from requirements doc)
// ---------------------------------------------------------------------------

/** Tools skills — enabled in "As bot" mode, disabled in "As you" mode. */
const TOOLS_SKILLS = [
  "lark-mail",
  "lark-minutes",
  "lark-openapi-explorer",
  "lark-skill-maker",
  "lark-calendar",
  "lark-workflow-standup-report",
  "lark-wiki",
  "lark-doc",
  "lark-contact",
  "lark-vc",
  "lark-drive",
  "lark-workflow-meeting-summary",
  "lark-shared",
  "lark-base",
  "lark-im",
  "lark-sheets",
  "lark-task",
  "lark-whiteboard",
  "feishu-doc",
  "feishu-drive",
  "feishu-perm",
  "feishu-wiki",
] as const;

/** lark-cli skills — no longer managed by onboarding. */
const LARKCLI_SKILLS: readonly string[] = [];

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

function setFeishuGroupAllowFrom(cfg: OpenClawConfig, groupAllowFrom: string[]): OpenClawConfig {
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      feishu: {
        ...cfg.channels?.feishu,
        groupAllowFrom,
      },
    },
  };
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
// Mode selection
// ---------------------------------------------------------------------------

async function promptAppMode(
  prompter: WizardPrompter,
  options?: {
    disableUser?: boolean;
    currentMode?: FeishuAppMode;
  },
): Promise<FeishuAppMode> {
  const userHint = options?.disableUser
    ? "Works under your identity, managing messages, docs, calendar, and more as you upon authorization. (\u26a0\ufe0f Unavailable with multiple linked bots. Remove unused bots to enable this option.)"
    : "Works under your identity, managing messages, docs, calendar, and more as you upon authorization.";

  const botOption = {
    value: "bot" as const,
    label: "As bot (recommended)",
    hint: "Works under its own identity. Best for group chats, team notifications, and shared documents.",
  };
  const userOption = {
    value: "user" as const,
    label: "As you",
    hint: userHint,
  };

  const selectOptions = options?.disableUser ? [botOption] : [botOption, userOption];

  return (await prompter.select({
    message: "How should the AI work with you?",
    options: selectOptions,
    initialValue: options?.currentMode ?? "bot",
  })) as FeishuAppMode;
}

// ---------------------------------------------------------------------------
// Skills configuration
// ---------------------------------------------------------------------------

/** Skills that are always disabled regardless of mode. */
const ALWAYS_DISABLED_SKILLS = ["lark-event"] as const;

/**
 * Returns which skills to disable and which to enable (remove from entries).
 *
 * - As you (user mode): disable tools skills
 * - As bot (bot mode): enable tools skills (remove disabled entries)
 * - lark-event is always disabled
 *
 * Disable = set `{ enabled: false }` in `skills.entries`
 * Enable  = remove the key from `skills.entries` so default behavior takes over
 */
function buildSkillsConfig(appMode: FeishuAppMode): {
  disable: Record<string, { enabled: false }>;
  enable: readonly string[];
} {
  const disable: Record<string, { enabled: false }> = {};

  // Always-disabled skills.
  for (const skill of ALWAYS_DISABLED_SKILLS) {
    disable[skill] = { enabled: false };
  }

  if (appMode === "user") {
    // User mode: enable lark-cli skills, disable tools skills.
    for (const skill of TOOLS_SKILLS) {
      disable[skill] = { enabled: false };
    }
    return { disable, enable: LARKCLI_SKILLS };
  }
  // Bot mode: enable tools skills, disable lark-cli skills.
  for (const skill of LARKCLI_SKILLS) {
    disable[skill] = { enabled: false };
  }
  return { disable, enable: TOOLS_SKILLS };
}

/** Apply skills config: disable target skills, remove opposite skills from entries. */
function applySkillsConfig(cfg: OpenClawConfig, appMode: FeishuAppMode): OpenClawConfig {
  const { disable, enable } = buildSkillsConfig(appMode);

  const existingSkills = (cfg as Record<string, unknown>).skills as
    | Record<string, unknown>
    | undefined;
  const existingEntries = (existingSkills?.entries ?? {}) as Record<string, unknown>;

  // Clone entries, remove keys that should be enabled, then merge disabled ones.
  const newEntries = { ...existingEntries };
  for (const skill of enable) {
    delete newEntries[skill];
  }
  Object.assign(newEntries, disable);

  return {
    ...cfg,
    skills: {
      ...existingSkills,
      entries: newEntries,
    },
  } as OpenClawConfig;
}

// ---------------------------------------------------------------------------
// Security policy helpers
// ---------------------------------------------------------------------------

function applyNewAppSecurityPolicy(
  cfg: OpenClawConfig,
  appMode: FeishuAppMode,
  openId: string | undefined,
): OpenClawConfig {
  let next = cfg;

  if (!openId) {
    return next;
  }

  // Both modes: dmPolicy=allowlist, allowFrom=[openId]
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    patch: { dmPolicy: "allowlist" },
  }) as OpenClawConfig;
  next = setFeishuAllowFrom(next, [openId]);

  // Both modes: groupPolicy=open
  next = setFeishuGroupPolicy(next, "open");

  // Enable wildcard groups.
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    patch: {
      groups: {
        ...((next.channels?.feishu as FeishuConfig | undefined)?.groups ?? {}),
        "*": { enabled: true },
      },
    },
  }) as OpenClawConfig;

  if (appMode === "user") {
    // User mode: also set groupSenderAllowFrom=[openId]
    next = setFeishuGroupSenderAllowFrom(next, [openId]);
  }

  return next;
}

// ---------------------------------------------------------------------------
// Scan-to-create flow
// ---------------------------------------------------------------------------

async function runScanToCreate(
  prompter: WizardPrompter,
  appMode: FeishuAppMode,
): Promise<AppRegistrationResult | null> {
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

  const tp = appMode === "user" ? "ob_user" : "ob_app";
  const outcome = await pollAppRegistration({
    deviceCode: begin.deviceCode,
    interval: begin.interval,
    expireIn: begin.expireIn,
    initialDomain: "feishu",
    tp,
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
// Install helpers
// ---------------------------------------------------------------------------

async function ensureLarkCliInstalled(): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    try {
      execSync("lark-cli --version", { stdio: "ignore" });
    } catch {
      execSync("npm install -g @larksuite/cli", { stdio: "ignore", timeout: 120_000 });
    }
  } catch {
    // install failed or node:child_process unavailable — skip silently.
  }
}

async function installLarkSkills(): Promise<void> {
  try {
    const { execSync } = await import("node:child_process");
    execSync("npx skills add larksuite/cli -y -g -a openclaw", {
      stdio: "ignore",
      timeout: 120_000,
    });
  } catch {
    // install failed or node:child_process unavailable — skip silently.
  }
}

// ---------------------------------------------------------------------------
// New app configuration flow
// ---------------------------------------------------------------------------

async function runNewAppFlow(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  options: Parameters<NonNullable<ChannelSetupWizard["finalize"]>>[0]["options"];
  appMode: FeishuAppMode;
  skipModeSelection?: boolean;
}): Promise<{ cfg: OpenClawConfig }> {
  const { prompter, options } = params;
  let next = params.cfg;
  const appMode = params.appMode;

  // Apply appMode to config.
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    enabled: true,
    patch: { appMode },
  }) as OpenClawConfig;

  // ----- QR scan flow -----
  let appId: string | null = null;
  let appSecret: SecretInput | null = null;
  let appSecretProbeValue: string | null = null;
  let scanDomain: FeishuDomain | undefined;
  let scanOpenId: string | undefined;

  const scanResult = await runScanToCreate(prompter, appMode);
  if (scanResult) {
    appId = scanResult.appId;
    appSecret = scanResult.appSecret;
    appSecretProbeValue = scanResult.appSecret;
    scanDomain = scanResult.domain;
    scanOpenId = scanResult.openId;
  } else {
    // Fallback to manual input.
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
  }

  // ----- Apply credentials, policies, skills & install (under one spinner) -----
  const configProgress = prompter.progress("Configuring...");
  // Yield to let the spinner render before sync work and execSync block the event loop.
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
    }) as OpenClawConfig;
  }

  if (scanDomain) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      patch: { domain: scanDomain },
    }) as OpenClawConfig;
  }

  next = applyNewAppSecurityPolicy(next, appMode, scanOpenId);
  next = applySkillsConfig(next, appMode);
  await ensureLarkCliInstalled();
  await installLarkSkills();
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

  const recommendations: string[] = [];
  let dmPatch: Partial<FeishuConfig> = {};
  let dmAllowFrom: string[] | undefined;
  let groupPatch: Partial<FeishuConfig> = {};
  let groupSenderAllowFrom: string[] | undefined;

  await prompter.note(
    "To keep your data safe while acting as you, we suggest these policy updates:",
    "Security recommendation",
  );

  if (needDmRecommendation) {
    if (ownerOpenId) {
      dmPatch = { dmPolicy: "allowlist" };
      dmAllowFrom = [ownerOpenId];
      recommendations.push("DMs: Only the owner");
    } else {
      dmPatch = { dmPolicy: "pairing" };
      recommendations.push("DMs: Only the paired user");
    }
  }

  if (needGroupRecommendation) {
    if (ownerOpenId) {
      groupSenderAllowFrom = [ownerOpenId];
      recommendations.push("Group chats: Only when mentioned by the owner");
    } else {
      groupPatch = { groupPolicy: "disabled" };
      recommendations.push("Group chats: Disabled");
    }
  }

  for (const rec of recommendations) {
    await prompter.note(`- ${rec}`, "");
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
    }) as OpenClawConfig;
  }
  if (dmAllowFrom) {
    next = setFeishuAllowFrom(next, dmAllowFrom);
  }
  if (Object.keys(groupPatch).length > 0) {
    next = patchTopLevelChannelConfigSection({
      cfg: next,
      channel,
      patch: groupPatch,
    }) as OpenClawConfig;
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
  const currentAppMode = (feishuCfg as Record<string, unknown> | undefined)?.appMode as
    | FeishuAppMode
    | undefined;

  // Framework already handles "already configured → update/skip" prompt.
  // Proceed directly to mode selection.
  const accountKeys = Object.keys(feishuCfg?.accounts ?? {});
  const hasMultipleAccounts = accountKeys.length > 1;

  const appMode = await promptAppMode(prompter, {
    disableUser: hasMultipleAccounts,
    currentMode: currentAppMode,
  });

  // Apply appMode.
  next = patchTopLevelChannelConfigSection({
    cfg: next,
    channel,
    patch: { appMode },
  }) as OpenClawConfig;

  // Step 3: Check existing appId.
  const existingAppId = normalizeString(feishuCfg?.appId);
  if (existingAppId) {
    const useExisting = await prompter.confirm({
      message: `We found an existing bot (App ID: ${existingAppId}). Use it for this setup?`,
      initialValue: true,
    });

    if (useExisting) {
      // Using existing bot.
      if (appMode === "bot") {
        // Bot mode with existing bot — skip to skills step.
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
      // User wants a new bot — run new app flow (skip mode selection).
      return runNewAppFlow({
        cfg: next,
        prompter,
        options,
        appMode,
        skipModeSelection: true,
      });
    }
  } else {
    // No existing appId — run new app flow (skip mode selection).
    return runNewAppFlow({
      cfg: next,
      prompter,
      options,
      appMode,
      skipModeSelection: true,
    });
  }

  // ----- Skills configuration & install -----
  const configProgress = prompter.progress("Configuring...");
  await new Promise((resolve) => setTimeout(resolve, 50));
  next = applySkillsConfig(next, appMode);
  await ensureLarkCliInstalled();
  await installLarkSkills();
  configProgress.stop("Bot configured.");

  return { cfg: next };
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
  prepare: async ({ cfg, credentialValues, prompter }) => {
    const alreadyConfigured = isFeishuConfigured(cfg);

    if (alreadyConfigured) {
      // Edit flow — mark for finalize.
      return {
        credentialValues: { ...credentialValues, _flow: "edit" },
      };
    }

    // New app flow — mark for finalize.
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
        // User chose to skip.
        return { cfg };
      }
      return result;
    }

    // New app flow — prompt mode then run.
    const appMode = await promptAppMode(prompter);
    return runNewAppFlow({ cfg, prompter, options, appMode });
  },

  dmPolicy: feishuDmPolicy,
  disable: (cfg) =>
    patchTopLevelChannelConfigSection({
      cfg,
      channel,
      patch: { enabled: false },
    }),
};
