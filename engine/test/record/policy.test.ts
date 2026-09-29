import { describe, expect, it } from "vitest";
import {
  approvedPolicy,
  MemoryApprovalStore,
  stanceOn,
  type Approval,
} from "../../src/record/policy.js";

let clock = 1;
function approval(
  kind: Approval["kind"],
  value: string,
  overrides: Partial<Approval> = {},
): Approval {
  return {
    kind,
    subject: {
      kind: kind === "write_manifest" || kind === "review_manifest" ? "tool" : "address",
      value,
    },
    at: clock++,
    by: "eric",
    shown: { considered: 3, changed: 3, speculative: false },
    ...overrides,
  };
}

describe("approvals become the live lists", () => {
  it("puts a trusted address on the allowlist and a blocked one on the deny-list", () => {
    const policy = approvedPolicy([
      approval("trust_address", "Friend"),
      approval("block_address", "Drain"),
    ]);
    expect(policy.allowlist).toEqual(["Friend"]);
    expect(policy.denylist).toEqual(["Drain"]);
  });

  it("lets the later decision win without deleting the earlier one", () => {
    // The log stays append-only -- that is what makes it evidence -- and the
    // current position is the replay of it in order.
    const policy = approvedPolicy([
      approval("trust_address", "Changed", { at: 10 }),
      approval("block_address", "Changed", { at: 20 }),
    ]);
    expect(policy.allowlist).toEqual([]);
    expect(policy.denylist).toEqual(["Changed"]);
  });

  it("does not care what order the log is read in", () => {
    const policy = approvedPolicy([
      approval("block_address", "Changed", { at: 20 }),
      approval("trust_address", "Changed", { at: 10 }),
    ]);
    expect(policy.denylist).toEqual(["Changed"]);
  });
});

describe("an approval that is really a code change says so", () => {
  it("keeps a manifest approval pending and out of every list", () => {
    const policy = approvedPolicy([
      approval("write_manifest", "SolanaLendTool", {
        shown: { considered: 12, changed: 0, speculative: true },
      }),
    ]);
    expect(policy.allowlist).toEqual([]);
    expect(policy.denylist).toEqual([]);
    expect(policy.pending).toHaveLength(1);
    // An operator who thinks they fixed the noise and did not will stop
    // trusting the queue, so this distinction is not cosmetic.
    expect(policy.pending[0]?.shown.speculative).toBe(true);
  });
});

describe("what was shown is kept, not recomputed", () => {
  it("stores the retrospect as it stood when the button was pressed", async () => {
    const store = new MemoryApprovalStore();
    await store.append(
      approval("trust_address", "Friend", {
        shown: { considered: 40, changed: 12, speculative: false },
      }),
    );
    const [stored] = await store.all();
    expect(stored?.shown).toEqual({
      considered: 40,
      changed: 12,
      speculative: false,
    });
  });

  it("refuses an approval with nobody attached to it", async () => {
    const store = new MemoryApprovalStore();
    await expect(
      store.append(approval("trust_address", "Friend", { by: "" })),
    ).rejects.toThrow();
  });
});

describe("the current position on a subject is readable for the interface", () => {
  it("reports the latest stance, and null when there is none", () => {
    const log = [
      approval("trust_address", "X", { at: 1 }),
      approval("block_address", "X", { at: 2 }),
    ];
    expect(stanceOn(log, { kind: "address", value: "X" })).toBe("block_address");
    expect(stanceOn(log, { kind: "address", value: "Y" })).toBeNull();
  });
});
