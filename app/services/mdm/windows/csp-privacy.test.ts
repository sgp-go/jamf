import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import { buildLetAppsAccessLocation } from "./csp-privacy.ts";

describe("csp-privacy", () => {
  describe("buildLetAppsAccessLocation", () => {
    it("預設 force_allow → value=1", () => {
      const cmd = buildLetAppsAccessLocation();
      expect(cmd.verb).toBe("Replace");
      expect(cmd.target).toBe(
        "./Device/Vendor/MSFT/Policy/Config/Privacy/LetAppsAccessLocation",
      );
      expect(cmd.format).toBe("int");
      expect(cmd.data).toBe("1");
    });

    it("user_control → value=0（OS 預設）", () => {
      const cmd = buildLetAppsAccessLocation("user_control");
      expect(cmd.data).toBe("0");
    });

    it("force_deny → value=2", () => {
      const cmd = buildLetAppsAccessLocation("force_deny");
      expect(cmd.data).toBe("2");
    });
  });
});
