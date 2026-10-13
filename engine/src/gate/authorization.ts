/**
 * The single-use authorisation that ties an ALLOW to specific bytes.
 *
 * Without it, the link between "AVAL said yes" and "these bytes got signed" is
 * convention. An agent can be handed an ALLOW for one transaction and put the
 * wallet's signature on another, and every record in the system would look
 * perfectly clean afterwards -- the verdict would even carry the right digest,
 * about a transaction nobody signed.
 *
 * So an ALLOW mints a ticket over the digest of the exact message that was
 * evaluated, and the SIGNER refuses any payload whose bytes do not hash to it.
 * The verification has to live on the signer's side. A check inside the gate,
 * which is the same code that already decided, is decoration.
 *
 * Four properties, each one closing a specific way around it:
 *
 *  - the MAC covers the digest, the action and the expiry TOGETHER, so none of
 *    the three can be swapped while keeping the other two;
 *  - the digest is recomputed from the bytes actually being signed, never read
 *    from anything the caller says about them;
 *  - a ticket is spent on first use, so an ALLOW cannot be replayed to sign
 *    the same transaction twice -- which on a blockchain is a second transfer;
 *  - a ticket expires, so it cannot be banked and used later against state
 *    that has moved.
 */
import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

export interface Authorization {
  readonly actionId: string;
  /** sha256 of the signable message, hex. */
  readonly messageDigest: string;
  /** Milliseconds since the epoch. */
  readonly expiresAt: number;
  /** HMAC-SHA256 over the three fields above, hex. */
  readonly mac: string;
}

export type AuthorizationCheck =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

export interface AuthorizerOptions {
  /**
   * The shared secret.
   *
   * Absent means one is generated, which is correct when the gate and the
   * signer run in the same process and WRONG the moment they do not: a signer
   * in another process that generates its own secret would reject every valid
   * ticket, and one that skips verification would accept every invalid one.
   * Pass it explicitly as soon as the signer is separate.
   */
  readonly secret?: Uint8Array;
  /**
   * How long a ticket lives. Short on purpose: a long-lived authorisation is
   * one an agent can hold until the wallet's state suits it better.
   */
  readonly ttlMs?: number;
}

const DEFAULT_TTL_MS = 30_000;

/** Field separator for the MAC input. */
const SEPARATOR = "|";

export function digestOfMessage(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export class Authorizer {
  private readonly secret: Uint8Array;
  private readonly ttlMs: number;
  /** MACs already used. A ticket is good exactly once. */
  private readonly spent = new Set<string>();

  constructor(options: AuthorizerOptions = {}) {
    this.secret = options.secret ?? randomBytes(32);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    if (this.secret.length < 16)
      throw new Error("the gate secret must be at least 16 bytes");
  }

  /**
   * The MAC input is LENGTH-PREFIXED, not just separated.
   *
   * With a separator alone, a field that contains the separator lets one
   * ticket read as another: ("a|b", "c") and ("a", "b|c") produce the same
   * string. Prefixing each field with its length removes the ambiguity
   * whatever the fields contain.
   */
  private macOf(
    actionId: string,
    messageDigest: string,
    expiresAt: number,
  ): string {
    const fields = [actionId, messageDigest, String(expiresAt)];
    const input = fields
      .map((field) => `${field.length}${SEPARATOR}${field}`)
      .join(SEPARATOR);
    return createHmac("sha256", this.secret).update(input).digest("hex");
  }

  /**
   * Mint a ticket for a message that was evaluated and allowed.
   *
   * `messageDigest` comes from the verdict, which took it from the bytes that
   * were normalised and simulated -- not from the caller's description of them.
   */
  issue(
    actionId: string,
    messageDigest: string,
    now = Date.now(),
  ): Authorization {
    const expiresAt = now + this.ttlMs;
    return {
      actionId,
      messageDigest,
      expiresAt,
      mac: this.macOf(actionId, messageDigest, expiresAt),
    };
  }

  /**
   * Verify a ticket against the bytes in front of the signer, and spend it.
   *
   * Every refusal path returns a reason instead of throwing, because the signer
   * has to be able to log WHY it refused. A refusal with no reason is how a
   * production integration ends up with the check turned off.
   */
  consume(
    authorization: Authorization,
    messageBytes: Uint8Array,
    now = Date.now(),
  ): AuthorizationCheck {
    const expected = this.macOf(
      authorization.actionId,
      authorization.messageDigest,
      authorization.expiresAt,
    );
    const given = Buffer.from(authorization.mac, "hex");
    const mine = Buffer.from(expected, "hex");
    if (given.length !== mine.length || !timingSafeEqual(given, mine))
      return { ok: false, reason: "the authorisation is not one we issued" };

    if (now > authorization.expiresAt)
      return { ok: false, reason: "the authorisation has expired" };

    if (this.spent.has(authorization.mac))
      return { ok: false, reason: "the authorisation has already been used" };

    // The whole point of the mechanism. Everything above proves the ticket is
    // ours; this proves it is about THIS transaction.
    const actual = digestOfMessage(messageBytes);
    if (actual !== authorization.messageDigest)
      return {
        ok: false,
        reason:
          "these bytes are not the ones that were approved" +
          ` (approved ${authorization.messageDigest.slice(0, 16)},` +
          ` presented ${actual.slice(0, 16)})`,
      };

    this.spent.add(authorization.mac);
    return { ok: true };
  }
}
