import { createCipheriv, createDecipheriv, randomBytes, scrypt } from "node:crypto";
import { UserError } from "./common.js";

/**
 * Encrypted credentials bundle (secrets.enc).
 *
 * Layout: header | ciphertext | 16-byte GCM tag
 * Header: magic "OCMSEC1" (7) | version (1) | log2(N) (1) | r (4, big endian) | p (4, big endian) | salt (16) | iv (12)
 * The whole header is authenticated as GCM additional data.
 */
export const BUNDLE_NAME = "secrets.enc";
const MAGIC = Buffer.from("OCMSEC1", "ascii");
const VERSION = 1;
const HEADER_LEN = 7 + 1 + 1 + 4 + 4 + 16 + 12;
const TAG_LEN = 16;
export const MIN_PASSPHRASE_LENGTH = 12;

export interface KdfParams {
  logN: number;
  r: number;
  p: number;
}
export const DEFAULT_KDF: KdfParams = { logN: 17, r: 8, p: 1 };

// Upper bounds protect against a tampered header that asks for absurd memory.
const MAX_LOGN = 22;
const MAX_R = 32;
const MAX_P = 16;

export interface BundlePayload {
  auth: unknown[];
  mcpSecrets: Record<string, string>;
  /** Redacted inline config secret values, marker name -> value. Absent in bundles written before M3.5. */
  configSecrets?: Record<string, string>;
}

export const BAD_BUNDLE = "The passphrase is wrong or the credentials file was changed.";

function derive(passphrase: string, salt: Buffer, k: KdfParams): Promise<Buffer> {
  const N = 2 ** k.logN;
  const maxmem = 128 * N * k.r * 2 + 16 * 1024 * 1024;
  return new Promise((resolve, reject) => {
    scrypt(Buffer.from(passphrase.normalize("NFKC"), "utf8"), salt, 32, { N, r: k.r, p: k.p, maxmem }, (err, key) =>
      err ? reject(err) : resolve(key),
    );
  });
}

export async function encryptBundle(payload: BundlePayload, passphrase: string, kdf: KdfParams = DEFAULT_KDF): Promise<Buffer> {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const header = Buffer.alloc(HEADER_LEN);
  let o = MAGIC.copy(header, 0);
  header[o++] = VERSION;
  header[o++] = kdf.logN;
  o = header.writeUInt32BE(kdf.r, o);
  o = header.writeUInt32BE(kdf.p, o);
  o += salt.copy(header, o);
  iv.copy(header, o);

  const key = await derive(passphrase, salt, kdf);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(header);
  const body = Buffer.concat([cipher.update(Buffer.from(JSON.stringify(payload), "utf8")), cipher.final()]);
  key.fill(0);
  return Buffer.concat([header, body, cipher.getAuthTag()]);
}

/** Decrypt a bundle. Every failure (wrong passphrase, damage, truncation, not a bundle) gives the same plain error. */
export async function decryptBundle(data: Buffer, passphrase: string): Promise<BundlePayload> {
  const fail = (): never => {
    throw new UserError(BAD_BUNDLE);
  };
  if (data.length < HEADER_LEN + TAG_LEN) return fail();
  if (!data.subarray(0, MAGIC.length).equals(MAGIC) || data[7] !== VERSION) return fail();
  const logN = data[8];
  const r = data.readUInt32BE(9);
  const p = data.readUInt32BE(13);
  if (logN < 10 || logN > MAX_LOGN || r < 1 || r > MAX_R || p < 1 || p > MAX_P) return fail();
  const header = data.subarray(0, HEADER_LEN);
  const salt = data.subarray(17, 33);
  const iv = data.subarray(33, 45);
  const body = data.subarray(HEADER_LEN, data.length - TAG_LEN);
  const tag = data.subarray(data.length - TAG_LEN);
  try {
    const key = await derive(passphrase, salt, { logN, r, p });
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(header);
    d.setAuthTag(tag);
    const plain = Buffer.concat([d.update(body), d.final()]);
    key.fill(0);
    const j = JSON.parse(plain.toString("utf8"));
    if (!j || !Array.isArray(j.auth) || typeof j.mcpSecrets !== "object" || j.mcpSecrets === null) return fail();
    if (j.configSecrets !== undefined && (typeof j.configSecrets !== "object" || j.configSecrets === null)) return fail();
    return { auth: j.auth, mcpSecrets: j.mcpSecrets as Record<string, string>, ...(j.configSecrets ? { configSecrets: j.configSecrets as Record<string, string> } : {}) };
  } catch {
    return fail();
  }
}

// ---------------------------------------------------------------- auth array helpers

export interface AuthSummary {
  label: string;
}

export function validateAuthArray(v: unknown): unknown[] {
  if (!Array.isArray(v)) throw new UserError("OpenCode returned credentials in an unexpected format.");
  for (const e of v) {
    if (!e || typeof e !== "object" || typeof (e as { id?: unknown }).id !== "string") {
      throw new UserError("OpenCode returned credentials in an unexpected format.");
    }
  }
  return v;
}

export function authLabels(auth: unknown[]): string[] {
  return auth.map((a) => {
    const e = a as { label?: unknown; integrationID?: unknown; id?: unknown };
    const label = typeof e.label === "string" && e.label ? e.label : "";
    const integ = typeof e.integrationID === "string" ? e.integrationID : "";
    return label && integ && label !== integ ? `${label} (${integ})` : label || integ || String(e.id);
  });
}

/** Every string value found inside the credential objects, used to scrub logs. */
export function collectSecretStrings(auth: unknown[], extra: string[] = []): string[] {
  const out = new Set<string>(extra);
  const walk = (v: unknown, key?: string): void => {
    if (typeof v === "string") {
      if (v.length >= 4 && key !== "id" && key !== "integrationID" && key !== "type") out.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
  };
  for (const a of auth) {
    const e = a as { value?: unknown };
    walk(e?.value);
  }
  return [...out].sort((a, b) => b.length - a.length);
}

export function scrub(text: string, secrets: string[]): string {
  let t = text;
  for (const s of secrets) if (s) t = t.split(s).join("***");
  return t;
}
