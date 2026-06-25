import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import {
  buildBitLockerAdmxInstall,
  buildBitLockerEnable,
  buildBitLockerClear,
  buildBitLockerStatusQuery,
} from "./csp-bitlocker.ts";

describe("csp-bitlocker", () => {
  describe("buildBitLockerAdmxInstall", () => {
    it("產生 ADMX Replace 命令（idempotent upsert）", () => {
      const cmd = buildBitLockerAdmxInstall();
      expect(cmd.verb).toBe("Replace");
      expect(cmd.target).toContain("ADMXInstall/CoGrowMDM/Policy/BitLockerPolicy");
      expect(cmd.format).toBe("chr");
      expect(cmd.data).toContain("CoGrow.MDM.BitLockerPolicies");
      expect(cmd.data).toContain("BitLockerEnable");
      expect(cmd.data).toContain('valueName="Pending"');
      expect(cmd.data).toContain('valueName="EncryptionId"');
      expect(cmd.data).toContain('valueName="EncryptionMethod"');
    });
  });

  describe("buildBitLockerEnable", () => {
    it("產生 Replace 命令帶 EncryptionId + EncryptionMethod", () => {
      const cmds = buildBitLockerEnable({
        encryptionId: "test-id-123",
        encryptionMethod: "XtsAes256",
      });
      expect(cmds).toHaveLength(1);
      expect(cmds[0].verb).toBe("Replace");
      expect(cmds[0].target).toContain("CoGrowBitLocker/BitLockerEnable");
      expect(cmds[0].format).toBe("chr");
      expect(cmds[0].data).toContain("<enabled/>");
      expect(cmds[0].data).toContain('value="test-id-123"');
      expect(cmds[0].data).toContain('value="XtsAes256"');
    });

    it("不帶 encryptionMethod 時預設 XtsAes256", () => {
      const cmds = buildBitLockerEnable({ encryptionId: "abc" });
      expect(cmds[0].data).toContain('value="XtsAes256"');
    });

    it("特殊字元正確跳脫", () => {
      const cmds = buildBitLockerEnable({
        encryptionId: 'id"<&>',
      });
      expect(cmds[0].data).toContain("&quot;");
      expect(cmds[0].data).toContain("&lt;");
      expect(cmds[0].data).toContain("&amp;");
    });
  });

  describe("buildBitLockerClear", () => {
    it("產生 disabled Replace 命令", () => {
      const cmds = buildBitLockerClear();
      expect(cmds).toHaveLength(1);
      expect(cmds[0].verb).toBe("Replace");
      expect(cmds[0].data).toBe("<disabled/>");
    });
  });

  describe("buildBitLockerStatusQuery", () => {
    it("預設查詢 Status 節點", () => {
      const cmds = buildBitLockerStatusQuery();
      expect(cmds).toHaveLength(1);
      expect(cmds[0].verb).toBe("Get");
      expect(cmds[0].target).toContain("BitLocker/Status");
    });

    it("空節點清單拋出錯誤", () => {
      expect(() => buildBitLockerStatusQuery([])).toThrow();
    });
  });
});
