import { describe, it } from "jsr:@std/testing/bdd";
import { expect } from "jsr:@std/expect";
import {
  buildAssignedAccessConfigXml,
  buildKioskApply,
  buildKioskQuery,
  buildKioskRemove,
} from "./csp-kiosk.ts";

describe("csp-kiosk", () => {
  describe("buildAssignedAccessConfigXml", () => {
    it("UWP 模式產生 KioskModeApp AppUserModelId XML", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "uwp",
        aumid: "Microsoft.WindowsCalculator_8wekyb3d8bbwe!App",
        autoLogonAccount: "student",
      });
      expect(xml).toContain(
        '<KioskModeApp AppUserModelId="Microsoft.WindowsCalculator_8wekyb3d8bbwe!App" />',
      );
      expect(xml).toContain("<Account>student</Account>");
      expect(xml).toContain("AssignedAccessConfiguration");
      expect(xml).not.toContain("BreakoutSequence");
      // UWP 模式不用 v4:ClassicAppPath
      expect(xml).not.toContain("v4:ClassicAppPath");
    });

    it("Edge Kiosk public_browsing 用 v4:ClassicAppPath + msedge.exe + kiosk args", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "edge_kiosk",
        edgeUrl: "https://exam.school.edu.tw",
        edgeVariant: "public_browsing",
        autoLogonAccount: "student",
      });
      expect(xml).toContain('xmlns:v4="http://schemas.microsoft.com/AssignedAccess/2021/config"');
      expect(xml).toContain(
        'v4:ClassicAppPath="%ProgramFiles(x86)%\\Microsoft\\Edge\\Application\\msedge.exe"',
      );
      expect(xml).toContain("--kiosk https://exam.school.edu.tw");
      expect(xml).toContain("--edge-kiosk-type=public-browsing");
      expect(xml).toContain("--kiosk-idle-timeout-minutes=2");
      expect(xml).toContain("--no-first-run");
      // 不再用 AllAppsList / rs5:AutoLaunch
      expect(xml).not.toContain("AllAppsList");
      expect(xml).not.toContain("rs5:AutoLaunch");
    });

    it("Edge Kiosk digital_signage 用 fullscreen 且不加 idle-timeout", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "edge_kiosk",
        edgeUrl: "https://display.school.edu.tw",
        edgeVariant: "digital_signage",
        autoLogonAccount: "kioskUser",
      });
      expect(xml).toContain("--edge-kiosk-type=fullscreen");
      expect(xml).not.toContain("--kiosk-idle-timeout-minutes");
      expect(xml).toContain("<Account>kioskUser</Account>");
    });

    it("Edge Kiosk 自訂 idleTimeoutMinutes 覆蓋預設 2 分鐘", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "edge_kiosk",
        edgeUrl: "https://exam.school.edu.tw",
        edgeVariant: "public_browsing",
        edgeIdleTimeoutMinutes: 10,
        autoLogonAccount: "student",
      });
      expect(xml).toContain("--kiosk-idle-timeout-minutes=10");
      expect(xml).not.toContain("--kiosk-idle-timeout-minutes=2");
    });

    it("breakoutSequence 有值 → 產生 v4:BreakoutSequence 節點", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "uwp",
        aumid: "Foo!App",
        autoLogonAccount: "student",
        breakoutSequence: "Ctrl+Alt+B",
      });
      expect(xml).toContain('<v4:BreakoutSequence Key="Ctrl+Alt+B" />');
      // v4 namespace，不是 rs5
      expect(xml).not.toContain("rs5:BreakoutSequence");
    });

    it("breakoutSequence null → 不產生 breakout 節點", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "uwp",
        aumid: "Foo!App",
        autoLogonAccount: "student",
        breakoutSequence: null,
      });
      expect(xml).not.toContain("BreakoutSequence");
    });

    it("特殊字元帳號名被 escape", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "uwp",
        aumid: "Foo!App",
        autoLogonAccount: 'ex&am"pl<e',
      });
      expect(xml).toContain("ex&amp;am&quot;pl&lt;e");
    });

    it("Edge URL 含 query & → args 被 escape 到 &amp;", () => {
      const xml = buildAssignedAccessConfigXml({
        appType: "edge_kiosk",
        edgeUrl: "https://exam.school.edu.tw/?sid=1&sub=math",
        edgeVariant: "public_browsing",
        autoLogonAccount: "student",
      });
      expect(xml).toContain("sid=1&amp;sub=math");
    });

    it("UWP 缺 aumid 拋錯", () => {
      expect(() =>
        buildAssignedAccessConfigXml({
          appType: "uwp",
          autoLogonAccount: "student",
        })
      ).toThrow(/aumid/);
    });

    it("Edge Kiosk 缺 edgeUrl 拋錯", () => {
      expect(() =>
        buildAssignedAccessConfigXml({
          appType: "edge_kiosk",
          edgeVariant: "public_browsing",
          autoLogonAccount: "student",
        })
      ).toThrow(/edgeUrl/);
    });
  });

  describe("buildKioskApply", () => {
    it("用 Replace verb 對 AssignedAccess Configuration", () => {
      const cmd = buildKioskApply({
        appType: "uwp",
        aumid: "Foo!App",
        autoLogonAccount: "student",
      });
      expect(cmd.verb).toBe("Replace");
      expect(cmd.target).toBe("./Vendor/MSFT/AssignedAccess/Configuration");
      expect(cmd.format).toBe("chr");
      expect(cmd.data).toContain("AssignedAccessConfiguration");
    });
  });

  describe("buildKioskRemove", () => {
    it("Delete verb 移除整個 configuration", () => {
      const cmd = buildKioskRemove();
      expect(cmd.verb).toBe("Delete");
      expect(cmd.target).toBe("./Vendor/MSFT/AssignedAccess/Configuration");
      expect(cmd.data).toBeUndefined();
    });
  });

  describe("buildKioskQuery", () => {
    it("Get verb 對帳", () => {
      const cmd = buildKioskQuery();
      expect(cmd.verb).toBe("Get");
      expect(cmd.target).toBe("./Vendor/MSFT/AssignedAccess/Configuration");
    });
  });
});
