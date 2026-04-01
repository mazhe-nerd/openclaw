import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { Type } from "@sinclair/typebox";
import type { OpenClawPluginApi } from "../runtime-api.js";
import { resolveFeishuToolAccount } from "./tool-account.js";
import type { ResolvedFeishuAccount } from "./types.js";

const execFileAsync = promisify(execFile);

/**
 * Lightweight shell-style tokenizer: splits on unquoted whitespace,
 * strips matching single/double quotes around tokens.
 */
function shellSplit(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote) {
      if (ch === quote) {
        quote = null;
      } else {
        current += ch;
      }
    } else if (ch === "'" || ch === '"') {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
    } else {
      current += ch;
    }
  }
  if (current) {
    tokens.push(current);
  }
  return tokens;
}

/** Detect `config init` as the leading subcommand, ignoring any flags AI may have added. */
function isConfigInitCommand(args: string[]): boolean {
  const positional = args.filter((a) => !a.startsWith("-"));
  return positional[0] === "config" && positional[1] === "init";
}

/**
 * Run `lark-cli config init` with credentials injected via --app-secret-stdin.
 * AI only needs to call `lark_cli(command: "lark-cli config init")` — the tool
 * takes over all parameters so the secret never appears in AI context.
 */
function executeConfigInit(account: ResolvedFeishuAccount): Promise<{
  content: Array<{ type: "text"; text: string }>;
  details: Record<string, unknown>;
}> {
  return new Promise((resolve) => {
    if (!account.appId || !account.appSecret) {
      resolve({
        content: [
          {
            type: "text" as const,
            text: "Error: Feishu account is missing appId or appSecret. Check your Feishu account configuration.",
          },
        ],
        details: { error: "missing_credentials" },
      });
      return;
    }

    const brand = account.domain === "lark" ? "lark" : "feishu";
    const args = [
      "config",
      "init",
      "--app-id",
      account.appId,
      "--app-secret-stdin",
      "--brand",
      brand,
    ];

    const child = spawn("lark-cli", args, {
      timeout: 30_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    child.stdin.write(account.appSecret);
    child.stdin.end();

    child.on("close", (code) => {
      const output = stdout.trim() || stderr.trim();
      if (code === 0) {
        resolve({
          content: [
            {
              type: "text" as const,
              text: output || "lark-cli configuration initialized successfully.",
            },
          ],
          details: { command: "config init", output },
        });
      } else {
        resolve({
          content: [
            {
              type: "text" as const,
              text: `lark-cli config init failed (exit ${code}).\n${output}`,
            },
          ],
          details: { command: "config init", error: output, exitCode: code },
        });
      }
    });

    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT" || err.code === "EACCES") {
        resolve({
          content: [
            {
              type: "text" as const,
              text:
                "[cli_not_installed] lark-cli is not installed.\n\n" +
                "Tell the user that lark-cli needs to be installed before proceeding, " +
                "then run the following steps in order:\n\n" +
                "Step 1 — Install the CLI binary:\n" +
                "  npm install -g @larksuite/cli\n\n" +
                "Step 2 — Install companion skills (provides domain-specific command guidance):\n" +
                "  npx skills add larksuite/cli -y\n\n" +
                "Step 3 — Verify installation:\n" +
                "  lark_cli(command: 'lark-cli version')\n\n" +
                "After all steps succeed, retry the original command.",
            },
          ],
          details: { error: "cli_not_installed" },
        });
      } else {
        resolve({
          content: [
            {
              type: "text" as const,
              text: `lark-cli config init error: ${err.message}`,
            },
          ],
          details: { command: "config init", error: err.message },
        });
      }
    });
  });
}

const AUTH_ERROR_PATTERNS = [
  /app.*not.*found/i,
  /invalid.*app.?id/i,
  /invalid.*app.?secret/i,
  /token.*invalid/i,
  /token.*expired/i,
  /unauthorized/i,
  /no.*app.*config/i,
  /config.*not.*found/i,
  /credential/i,
];

function isAuthOrConfigError(output: string): boolean {
  return AUTH_ERROR_PATTERNS.some((pattern) => pattern.test(output));
}

export function registerFeishuCliTool(api: OpenClawPluginApi) {
  api.registerTool(
    (ctx) => {
      const defaultAccountId = ctx.agentAccountId;

      return {
        name: "lark_cli",
        label: "Lark CLI",
        description:
          "Execute lark-cli commands for Feishu/Lark platform operations " +
          "(calendar, docs, sheets, base, tasks, drive, contacts, mail, " +
          "meetings, etc.). Refer to lark-* skills for available commands.",
        parameters: Type.Object({
          command: Type.String({
            description:
              "The lark-cli command to execute, " +
              "e.g. 'lark-cli calendar +agenda --days 3 --format json'",
          }),
          accountId: Type.Optional(
            Type.String({
              description: "Feishu account ID, omit for default",
            }),
          ),
        }),

        async execute(_toolCallId: string, params: { command: string; accountId?: string }) {
          const account = resolveFeishuToolAccount({
            api,
            executeParams: { accountId: params.accountId },
            defaultAccountId,
          });

          if (!account.appId) {
            return {
              content: [{ type: "text" as const, text: "Error: Feishu account not configured" }],
              details: { error: "account_not_configured" },
            };
          }

          let commandArgs = shellSplit(params.command);
          if (commandArgs[0] === "lark-cli") {
            commandArgs = commandArgs.slice(1);
          }

          if (commandArgs.length === 0) {
            return {
              content: [{ type: "text" as const, text: "Error: empty command" }],
              details: { error: "empty_command" },
            };
          }

          // Intercept `config init` — inject credentials via stdin, ignore AI-provided flags
          if (isConfigInitCommand(commandArgs)) {
            return executeConfigInit(account);
          }

          const args = ["--app-id", account.appId, ...commandArgs];

          try {
            const { stdout, stderr } = await execFileAsync("lark-cli", args, {
              timeout: 60_000,
              maxBuffer: 2 * 1024 * 1024,
            });
            const output = stdout.trim() || stderr.trim() || "(no output)";
            return {
              content: [{ type: "text" as const, text: output }],
              details: { command: params.command, output },
            };
          } catch (err: unknown) {
            const execErr = err as {
              code?: string;
              stdout?: string;
              stderr?: string;
              message?: string;
            };

            // lark-cli not installed or not executable
            if (execErr.code === "ENOENT" || execErr.code === "EACCES") {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      "[cli_not_installed] lark-cli is not installed.\n\n" +
                      "Tell the user that lark-cli needs to be installed before proceeding, " +
                      "then run the following steps in order:\n\n" +
                      "Step 1 — Install the CLI binary:\n" +
                      "  npm install -g @larksuite/cli\n\n" +
                      "Step 2 — Install companion skills (provides domain-specific command guidance):\n" +
                      "  npx skills add larksuite/cli -y\n\n" +
                      "Step 3 — Verify installation:\n" +
                      "  lark_cli(command: 'lark-cli version')\n\n" +
                      "After all steps succeed, retry the original command.",
                  },
                ],
                details: { error: "cli_not_installed" },
              };
            }

            const output =
              execErr.stdout?.trim() ||
              execErr.stderr?.trim() ||
              execErr.message ||
              "lark-cli execution failed";

            // Detect auth/config errors and guide AI to run config init
            if (isAuthOrConfigError(output)) {
              return {
                content: [
                  {
                    type: "text" as const,
                    text:
                      `[cli_not_configured] ${output}\n\n` +
                      "lark-cli is not configured for this account. " +
                      "Run lark_cli(command: 'lark-cli config init') to initialize, " +
                      "then retry the original command.",
                  },
                ],
                details: { command: params.command, error: "cli_not_configured" },
              };
            }

            return {
              content: [{ type: "text" as const, text: output }],
              details: { command: params.command, error: output },
            };
          }
        },
      };
    },
    { name: "lark_cli" },
  );
}
