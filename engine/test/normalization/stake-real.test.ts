/**
 * Real mainnet stake accounts, read by our decoder and compared with what the
 * RPC's own `jsonParsed` reported for the same bytes at the same moment.
 *
 * Recorded 2026-09-30 from stake-pool withdrawals. All three are in the
 * `initialized` state, which exercises the meta layout (authorities, lockup,
 * rent reserve); the delegation offsets are covered by the assembled bytes in
 * `stake.test.ts`, and a delegated account should be added here when one is
 * recorded.
 */
import { describe, expect, it } from "vitest";
import { decodeStakeAccount, STAKE_PROGRAM_ID } from "../../src/normalization/stake.js";

const REAL = [
  {
    account: "rsrxDvYUXjH1RQj2Ke36LNZEVqGztATxFkqNukERqFT",
    base64:
      "AQAAAIDVIgAAAAAAUeLOpIidOn+P5CE01YI9fcxOSS+/rEGZUv14Q3lLyZlR4s6kiJ06f4/kITTVgj19zE5JL7+sQZlS/XhDeUvJmQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    rpc: {
      type: "initialized",
      staker: "6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2",
      withdrawer: "6WecYymEARvjG5ZyqkrVQ6YkhPfujNzWpSPwNKXHCbV2",
      custodian: "11111111111111111111111111111111",
      rentExemptReserve: 2_282_880n,
    },
  },
  {
    account: "BgKUXdS29YcHCFrPm5M8oLHiTzZaMDjsebggjoaQ6KFL",
    base64:
      "AQAAAIDVIgAAAAAAVOWeJMBRqKFKex6Xl/DhLN+nSQIWZTGVpqUSpvFmYCtU5Z4kwFGooUp7HpeX8OEs36dJAhZlMZWmpRKm8WZgKwAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    rpc: {
      type: "initialized",
      staker: "6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS",
      withdrawer: "6iQKfEyhr3bZMotVkW6beNZz5CPAkiwvgV2CTje9pVSS",
      custodian: "11111111111111111111111111111111",
      rentExemptReserve: 2_282_880n,
    },
  },
  {
    account: "Bz2TwrNkjFseLBLSSymxWF7L5mT3WZUqZcLh7J7JKNBE",
    base64:
      "AQAAAIDVIgAAAAAAzURjgCXSaDBeVgp/8DhHo//OaR75Xt9PgYeSjLRaMYLNRGOAJdJoMF5WCn/wOEej/85pHvle30+Bh5KMtFoxggAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    rpc: {
      type: "initialized",
      staker: "EpH4ZKSeViL5qAHA9QANYVHxdmuzbUH2T79f32DmSCaM",
      withdrawer: "EpH4ZKSeViL5qAHA9QANYVHxdmuzbUH2T79f32DmSCaM",
      custodian: "11111111111111111111111111111111",
      rentExemptReserve: 2_282_880n,
    },
  },
];

describe("real stake accounts decode the way the RPC decodes them", () => {
  for (const sample of REAL) {
    it(sample.account, () => {
      const data = Buffer.from(sample.base64, "base64");
      expect(data.length).toBe(200);
      const decoded = decodeStakeAccount(data, STAKE_PROGRAM_ID);
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value.state).toBe(sample.rpc.type);
      expect(decoded.value.staker).toBe(sample.rpc.staker);
      expect(decoded.value.withdrawer).toBe(sample.rpc.withdrawer);
      expect(decoded.value.lockup.custodian).toBe(sample.rpc.custodian);
      expect(decoded.value.lockup.epoch).toBe(0n);
      expect(decoded.value.lockup.unixTimestamp).toBe(0n);
      expect(decoded.value.rentExemptReserve).toBe(sample.rpc.rentExemptReserve);
      expect(decoded.value.delegation).toBeNull();
    });
  }
});
