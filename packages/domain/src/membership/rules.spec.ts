// Ticket 20: membership domain rules — pure function unit tests.
// Covers: fail-closed, expiry, dirty-data, unknown-status → free; member → unlimited.
import { describe, expect, it } from "vitest";
import {
  dailyLimitFor,
  effectiveEntitlement,
  FREE_DAILY_LIMIT_MINUTES,
  type MembershipFact,
} from "./rules.js";

const FIXED_NOW = new Date("2026-08-17T12:00:00Z");

function member(overrides: Partial<MembershipFact> = {}): MembershipFact {
  return {
    plan: "member",
    status: "active",
    startedAt: "2025-01-01T00:00:00Z",
    expiresAt: null,
    ...overrides,
  };
}

describe("effectiveEntitlement / fail-closed", () => {
  it("no row → free", () => {
    const e = effectiveEntitlement(null, FIXED_NOW);
    expect(e.kind).toBe("free");
    expect(e.dailyLimitMinutes).toBe(FREE_DAILY_LIMIT_MINUTES);
  });

  it("undefined row → free", () => {
    expect(effectiveEntitlement(undefined, FIXED_NOW).kind).toBe("free");
  });

  it("free plan → free", () => {
    const e = effectiveEntitlement(
      {
        plan: "free",
        status: "active",
        startedAt: new Date(0).toISOString(),
        expiresAt: null,
      },
      FIXED_NOW,
    );
    expect(e.kind).toBe("free");
    expect(e.dailyLimitMinutes).toBe(FREE_DAILY_LIMIT_MINUTES);
  });

  it("member expired status → free", () => {
    const e = effectiveEntitlement(member({ status: "expired" }), FIXED_NOW);
    expect(e.kind).toBe("free");
  });

  it("member expires_at in the past → free (even with status active)", () => {
    const e = effectiveEntitlement(member({ expiresAt: "2025-01-01T00:00:00Z" }), FIXED_NOW);
    expect(e.kind).toBe("free");
  });

  it("member with invalid expires_at → free (fail-closed)", () => {
    const e = effectiveEntitlement(member({ expiresAt: "not-a-date" }), FIXED_NOW);
    expect(e.kind).toBe("free");
  });

  it("member indefinite (expiresAt null) active → unlimited", () => {
    const e = effectiveEntitlement(member(), FIXED_NOW);
    expect(e.kind).toBe("member");
    expect(e.dailyLimitMinutes).toBe(Infinity);
  });

  it("member with future expires_at active → unlimited", () => {
    const e = effectiveEntitlement(member({ expiresAt: "2027-01-01T00:00:00Z" }), FIXED_NOW);
    expect(e.kind).toBe("member");
    expect(e.dailyLimitMinutes).toBe(Infinity);
  });

  it("dirty data (missing required fields) → free (fail-closed)", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const bad = { plan: "member" } as any;
    expect(effectiveEntitlement(bad, FIXED_NOW).kind).toBe("free");
  });
});

describe("dailyLimitFor", () => {
  it("free/null → finite 15", () => {
    expect(dailyLimitFor(null, FIXED_NOW)).toBe(FREE_DAILY_LIMIT_MINUTES);
  });

  it("live member → Infinity", () => {
    expect(dailyLimitFor(member(), FIXED_NOW)).toBe(Infinity);
  });
});
