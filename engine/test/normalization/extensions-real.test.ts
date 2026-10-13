/**
 * A real Token-2022 mint, read by our extension reader and compared with what
 * the RPC's `jsonParsed` reported for the same bytes at the same moment.
 *
 * PYUSD, recorded 2026-09-30. It carries the two extensions the reader exists
 * for: a permanent delegate (who can move every holder's tokens) and a
 * transfer-hook slot (empty on this mint). The RPC said:
 *
 *   permanentDelegate.delegate = 2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk
 *   transferHook.programId     = null
 *
 * Only the first 400 base64 characters are kept: enough to reach the close
 * authority and the permanent delegate. The TLV walk hits the cut, reports
 * the tail as malformed, and claims nothing about what lies past it.
 */
import { describe, expect, it } from "vitest";
import {
  opaqueExtensionsOf,
  permanentDelegateOf,
  TOKEN_2022_PROGRAM_ID,
  transferHookProgramOf,
} from "../../src/normalization/spl.js";

const PYUSD_HEAD =
  "AQAAAGyRqkllkBL4q+lh7CS2EHSSZUdTL/CU7VtpOYLbmHMT6AQ1ncmkAgAGAQEAAAAXhTJh72q4Uypn8FOGWq0xKT/PB88SCrW5oVcGVI3AKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAQMAIAAXhTJh72q4Uypn8FOGWq0xKT/PB88SCrW5oVcGVI3AKwwAIAAXhTJh72q4Uypn8FOGWq0xKT/PB88SCrW5oVcGVI3AKwEAbAAXhTJh72q4Uypn8FOGWq0xKT/PB88SCrW5oVcGVI3AKxeFMmHvarhTKmfwU4ZarTEpP88HzxIKtbmh";

const DELEGATE = "2apBGMsS6ti9RyF5TwQTDswXBWskiJP2LD4cUEDqYJjk";

describe("PYUSD's extensions, against the RPC's reading", () => {
  const data = Buffer.from(PYUSD_HEAD, "base64");

  it("names the permanent delegate, with its address", () => {
    expect(permanentDelegateOf(data)).toBe(DELEGATE);
    expect(opaqueExtensionsOf(TOKEN_2022_PROGRAM_ID, data)).toContain(
      `PermanentDelegate(${DELEGATE})`,
    );
  });

  it("reads the mint-close authority as opaque too", () => {
    expect(opaqueExtensionsOf(TOKEN_2022_PROGRAM_ID, data)).toContain(
      "MintCloseAuthority",
    );
  });

  it("does not invent a hook program where the RPC saw none", () => {
    // The head is cut before the hook entry, so nothing is claimed about it.
    expect(transferHookProgramOf(data)).toBeNull();
  });
});
