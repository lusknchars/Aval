/**
 * The corrector's one hard rule: it never touches an address or an amount.
 * Enforced here, not trusted to the corrector.
 */
import { describe, expect, it } from "vitest";
import { malformedAddresses, safeCorrection } from "../../src/capture/corrector.js";

const ADDR = "9DwkxFA219HX4AGywf13T8c9j9MPzw7xACzERLUXF5HL";
const OTHER = "BfwiJ8thDzWHZX3KvArCDBdv1uCxh1F8x5p9PX4DJ3Td";

describe("a correction is accepted only when it changed nothing that matters", () => {
  it("accepts a spelling fix around an address", () => {
    const result = safeCorrection(`mnada 0.5 SOL pra ${ADDR}`, `manda 0.5 SOL para ${ADDR}`);
    expect(result).toEqual({ ok: true, text: `manda 0.5 SOL para ${ADDR}` });
  });

  it("refuses a correction that changed one character of an address", () => {
    const changed = `${ADDR.slice(0, -1)}M`;
    const result = safeCorrection(`manda pra ${ADDR}`, `manda para ${changed}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/changed an address or amount/);
  });

  it("refuses a correction that introduced an address", () => {
    const result = safeCorrection("manda pra ele", `manda para ${OTHER}`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/number of addresses or amounts/);
  });

  it("refuses a correction that changed an amount", () => {
    expect(safeCorrection("manda 0.5 SOL", "manda 5 SOL").ok).toBe(false);
    expect(safeCorrection("manda 1,000 USDC", "manda 1.000 USDC").ok).toBe(false);
  });

  it("refuses a correction that removed an amount", () => {
    expect(safeCorrection("manda 0.5 SOL pro Pedro", "manda SOL pro Pedro").ok).toBe(false);
  });

  it("does not care where in the sentence the address moved to", () => {
    expect(safeCorrection(`${ADDR} recebe 2 SOL`, `envie 2 SOL para ${ADDR}`).ok).toBe(true);
  });
});

describe("a broken address is a warning, never a fix", () => {
  it("spots a token that is almost an address", () => {
    // A 0 where an o should be: base58 has no zero.
    const broken = `${ADDR.slice(0, 10)}0${ADDR.slice(11)}`;
    expect(malformedAddresses(`manda pra ${broken}`)).toEqual([broken]);
  });

  it("does not flag a valid address, or ordinary words", () => {
    expect(malformedAddresses(`manda pra ${ADDR} agora`)).toEqual([]);
    expect(malformedAddresses("rebalance my portfolio please")).toEqual([]);
  });
});
