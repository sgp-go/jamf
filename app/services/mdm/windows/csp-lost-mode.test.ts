import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import {
  buildLostModeAdmxInstall,
  buildLostModeEnable,
  buildLostModeDisable,
  AGENT_LOST_MODE_REG_PATH,
} from "./csp-lost-mode.ts";

describe("csp-lost-mode", () => {
  describe("buildLostModeAdmxInstall", () => {
    it("產生 ADMX Replace 命令（idempotent upsert）", () => {
      const cmd = buildLostModeAdmxInstall();
      expect(cmd.verb).toBe("Replace");
      expect(cmd.target).toContain("ADMXInstall/CoGrowMDM/Policy/LostModePolicy");
      expect(cmd.format).toBe("chr");
      expect(cmd.data).toContain("CoGrow.MDM.LostModePolicies");
      expect(cmd.data).toContain("LostModeState");
      expect(cmd.data).toContain('valueName="Enabled"');
      expect(cmd.data).toContain('valueName="Message"');
      expect(cmd.data).toContain('valueName="Phone"');
      expect(cmd.data).toContain('valueName="Footnote"');
      expect(cmd.data).toContain('valueName="LostModeId"');
    });

    it("ADMX key path 對齊 Agent 讀取的 Registry 路徑", () => {
      // Agent C# GpsCollector 讀 HKLM\Software\CoGrow\Agent\LostMode\Enabled，
      // ADMX key 必須一致才能讓 OS 落值到此處。
      const cmd = buildLostModeAdmxInstall();
      expect(cmd.data).toContain('key="Software\\CoGrow\\Agent\\LostMode"');
      expect(AGENT_LOST_MODE_REG_PATH).toBe("SOFTWARE/CoGrow/Agent/LostMode");
    });
  });

  describe("buildLostModeEnable", () => {
    it("產生 3 條 Replace 命令：ADMX state + LegalNotice Caption + LegalNotice Text", () => {
      const cmds = buildLostModeEnable({
        message: "請聯絡光復國小資訊組",
        phone: "02-1234-5678",
        footnote: "拾獲者請聯絡校方",
        lostModeId: "abc-123",
      });
      expect(cmds).toHaveLength(3);

      // 1. ADMX state（Agent GpsCollector 用）
      expect(cmds[0].verb).toBe("Replace");
      expect(cmds[0].target).toContain("CoGrowLostMode/LostModeState");
      expect(cmds[0].format).toBe("chr");
      expect(cmds[0].data).toContain("<enabled/>");
      expect(cmds[0].data).toContain('value="請聯絡光復國小資訊組"');
      expect(cmds[0].data).toContain('value="02-1234-5678"');
      expect(cmds[0].data).toContain('value="拾獲者請聯絡校方"');
      expect(cmds[0].data).toContain('value="abc-123"');

      // 2. LegalNoticeCaption（標題）
      expect(cmds[1].target).toContain(
        "LocalPoliciesSecurityOptions/InteractiveLogon_MessageTitleForUsersAttemptingToLogOn",
      );
      expect(cmds[1].data).toBe("設備已啟用遺失模式");

      // 3. LegalNoticeText（正文，分行）
      expect(cmds[2].target).toContain(
        "LocalPoliciesSecurityOptions/InteractiveLogon_MessageTextForUsersAttemptingToLogOn",
      );
      expect(cmds[2].data).toContain("請聯絡光復國小資訊組");
      expect(cmds[2].data).toContain("聯絡電話:02-1234-5678".replace(":", "："));
      expect(cmds[2].data).toContain("拾獲者請聯絡校方");
      // 分行符
      expect(cmds[2].data).toContain("\n\n");
    });

    it("footnote 省略時 ADMX 仍給空字串、LegalNoticeText 不含 footnote 段", () => {
      const cmds = buildLostModeEnable({
        message: "找回我",
        phone: "111",
        lostModeId: "id-1",
      });
      expect(cmds[0].data).toContain('id="Footnote" value=""');
      // LegalNoticeText 不含空 footnote 段（filter 過濾空字串）
      const text = cmds[2].data as string;
      expect(text).toBe("找回我\n\n聯絡電話:111".replace(":", "："));
    });

    it("ADMX state 特殊字元正確跳脫（防 XML injection）", () => {
      const cmds = buildLostModeEnable({
        message: 'msg"<&>',
        phone: "<phone>",
        lostModeId: "id-1",
      });
      expect(cmds[0].data).toContain("&quot;");
      expect(cmds[0].data).toContain("&lt;");
      expect(cmds[0].data).toContain("&amp;");
      // LegalNoticeText 是 raw text，syncml.ts 層做 escapeXml；本層不 escape
      expect(cmds[2].data).toContain('msg"<&>');
    });
  });

  describe("buildLostModeDisable", () => {
    it("產生 3 條清除命令：ADMX disabled + LegalNotice Caption/Text 空字串", () => {
      const cmds = buildLostModeDisable();
      expect(cmds).toHaveLength(3);

      expect(cmds[0].verb).toBe("Replace");
      expect(cmds[0].target).toContain("CoGrowLostMode/LostModeState");
      expect(cmds[0].data).toBe("<disabled/>");

      expect(cmds[1].target).toContain("InteractiveLogon_MessageTitleForUsersAttemptingToLogOn");
      expect(cmds[1].data).toBe("");

      expect(cmds[2].target).toContain("InteractiveLogon_MessageTextForUsersAttemptingToLogOn");
      expect(cmds[2].data).toBe("");
    });
  });
});
