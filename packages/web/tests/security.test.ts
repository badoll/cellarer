import { describe, expect, it } from "vitest";
import { CSP, isLoopbackHost, safeEqual } from "../src/security.js";

describe("web/security safeEqual", () => {
  it("returns true only for exact equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
  });
  it("returns false (not throw) for unequal lengths", () => {
    // timingSafeEqual 对不等长会抛 RangeError;safeEqual 必须先判长度。
    expect(safeEqual("short", "a-much-longer-token")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("web/security isLoopbackHost", () => {
  it("allows loopback hosts (with/without port) and empty", () => {
    expect(isLoopbackHost("")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:4317")).toBe(true);
    expect(isLoopbackHost("localhost:4317")).toBe(true);
    expect(isLoopbackHost("[::1]:4317")).toBe(true);
  });
  it("forbids non-loopback hosts", () => {
    expect(isLoopbackHost("evil.example.com")).toBe(false);
    expect(isLoopbackHost("10.0.0.5")).toBe(false);
  });
  it("forbids startsWith-style DNS-rebinding bypasses (exact match, not prefix)", () => {
    // 回归:不能用 startsWith,否则下列 Host 会被误判为本机 → DNS rebinding 击穿。
    expect(isLoopbackHost("127.0.0.1.evil.com")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.com:4317")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
    expect(isLoopbackHost("localhostx")).toBe(false);
    expect(isLoopbackHost("127.0.0.1anything")).toBe(false);
  });
});

describe("web/security CSP", () => {
  it("restricts script-src to self (no external/inline scripts)", () => {
    expect(CSP).toContain("script-src 'self'");
    expect(CSP).toContain("default-src 'self'");
  });
});
