import { readFileSync, statSync } from "node:fs";
import { UserError } from "./common.js";
import { MIN_PASSPHRASE_LENGTH } from "./secrets.js";

export const PASSPHRASE_ENV = "OPENCODE_PORTABLE_PASSPHRASE";

export interface PassphraseConfig {
  file?: string;
  env?: NodeJS.ProcessEnv;
  isTTY?: boolean;
  /** Reads one line with echo off. Injected in tests. */
  prompt?: (question: string) => Promise<string>;
  warn?: (message: string) => void;
}

export interface PassphraseProvider {
  /** True when a non-interactive source (file or environment variable) is configured. */
  hasStaticSource: boolean;
  /** True when a hidden prompt is possible. */
  canPrompt: boolean;
  get(opts: { confirm?: boolean; minLength?: number }): Promise<string>;
}

/** Read one line from the terminal without echoing it. */
export function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    let buf = "";
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    const finish = (): void => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener("data", onData);
      process.stderr.write("\n");
    };
    const onData = (chunk: string): void => {
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n" || ch === "\u0004") {
          finish();
          return resolve(buf);
        }
        if (ch === "\u0003") {
          finish();
          return reject(new UserError("Cancelled."));
        }
        if (ch === "\u007f" || ch === "\b") buf = buf.slice(0, -1);
        else buf += ch;
      }
    };
    stdin.on("data", onData);
  });
}

export function makePassphraseProvider(cfg: PassphraseConfig): PassphraseProvider {
  const env = cfg.env ?? process.env;
  const isTTY = cfg.isTTY ?? !!(process.stdin.isTTY && process.stderr.isTTY);
  const prompt = cfg.prompt ?? promptHidden;
  const hasFile = !!cfg.file;
  const hasEnv = !!env[PASSPHRASE_ENV];

  const check = (p: string, minLength?: number): string => {
    if (!p) throw new UserError("The passphrase is empty.");
    if (minLength && [...p].length < minLength) {
      throw new UserError(`The passphrase must be at least ${minLength} characters long.`);
    }
    return p;
  };

  return {
    hasStaticSource: hasFile || hasEnv,
    canPrompt: isTTY,
    async get({ confirm, minLength } = {}) {
      if (cfg.file) {
        let text: string;
        try {
          const st = statSync(cfg.file);
          if (process.platform !== "win32" && (st.mode & 0o077) !== 0) {
            cfg.warn?.(`The passphrase file ${cfg.file} can be read by other users. Run: chmod 600 ${cfg.file}`);
          }
          text = readFileSync(cfg.file, "utf8");
        } catch {
          throw new UserError(`The passphrase file could not be read: ${cfg.file}`);
        }
        return check(text.replace(/\r?\n+$/, ""), minLength);
      }
      if (env[PASSPHRASE_ENV]) return check(env[PASSPHRASE_ENV]!, minLength);
      if (!isTTY) {
        throw new UserError(
          `No passphrase available. Use --passphrase-file PATH, set ${PASSPHRASE_ENV}, or run in a terminal to be asked.`,
        );
      }
      const first = check(await prompt("Passphrase: "), minLength);
      if (confirm) {
        const again = await prompt("Repeat passphrase: ");
        if (again !== first) throw new UserError("The two passphrases do not match.");
      }
      return first;
    },
  };
}
