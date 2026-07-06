import { appDeployAdminApp } from "~/routes/v1/admin/app-deploy.ts";
import { appsAdminApp } from "~/routes/v1/admin/apps.ts";
import { auditAdminApp } from "~/routes/v1/admin/audit.ts";
import { complianceAdminApp } from "~/routes/v1/admin/compliance.ts";
import { deviceGroupsAdminApp } from "~/routes/v1/admin/device-groups.ts";
import { devicePoliciesAdminApp } from "~/routes/v1/admin/device-policies.ts";
import { geofencesAdminApp } from "~/routes/v1/admin/geofences.ts";
import { devicesAdminApp } from "~/routes/v1/admin/devices.ts";
import { enrollmentPpkgAdminApp } from "~/routes/v1/admin/enrollment-ppkg.ts";
import { firewallAdminApp } from "~/routes/v1/admin/firewall.ts";
import { kioskAdminApp } from "~/routes/v1/admin/kiosk.ts";
import { installAgentAdminApp } from "~/routes/v1/admin/install-agent.ts";
import { jamfInstancesAdminApp } from "~/routes/v1/admin/jamf-instances.ts";
import { bitlockerAdminApp } from "~/routes/v1/admin/bitlocker.ts";
import { lapsAdminApp } from "~/routes/v1/admin/laps.ts";
import { profilePresetsApp } from "~/routes/v1/admin/profile-presets.ts";
import { profilesAdminApp } from "~/routes/v1/admin/profiles.ts";
import { tenantsAdminApp } from "~/routes/v1/admin/tenants.ts";
import { webhooksAdminApp } from "~/routes/v1/admin/webhooks.ts";
import { webhookEndpointsAdminApp } from "~/routes/v1/admin/webhook-endpoints.ts";
import { wingetDeployAdminApp } from "~/routes/v1/admin/winget-deploy.ts";
import { agentApp } from "~/routes/v1/agent.ts";
import { appsApp } from "~/routes/v1/apps.ts";
import { devicesApp } from "~/routes/v1/devices.ts";
import { jamfDevicesApp } from "~/routes/v1/jamf-devices.ts";
import windowsMdm from "~/routes/windows-mdm.ts";

/**
 * 一個待掛載的子 app（basePath + Hono 實例）。
 * app 型別用 any —— 子 app 混用 OpenAPIHono<never> 與 plain Hono，
 * 兩者的 Env 泛型不相容無法統一成單一型別；route() 在 runtime 皆接受。
 */
export interface Mount {
  basePath: string;
  // deno-lint-ignore no-explicit-any
  app: any;
}

/** MDM Control API（台灣後端調用，`/api/v1/*`，不含 Agent 上報）。 */
export const controlApiMounts: Mount[] = [
  { basePath: "/api/v1", app: devicesApp },
  { basePath: "/api/v1", app: jamfDevicesApp },
  { basePath: "/api/v1", app: appsApp },
  { basePath: "/api/v1", app: tenantsAdminApp },
  { basePath: "/api/v1", app: deviceGroupsAdminApp },
  { basePath: "/api/v1", app: devicesAdminApp },
  { basePath: "/api/v1", app: jamfInstancesAdminApp },
  { basePath: "/api/v1", app: appsAdminApp },
  { basePath: "/api/v1", app: appDeployAdminApp },
  { basePath: "/api/v1", app: wingetDeployAdminApp },
  { basePath: "/api/v1", app: installAgentAdminApp },
  { basePath: "/api/v1", app: enrollmentPpkgAdminApp },
  { basePath: "/api/v1", app: profilesAdminApp },
  { basePath: "/api/v1", app: profilePresetsApp },
  { basePath: "/api/v1", app: complianceAdminApp },
  { basePath: "/api/v1", app: auditAdminApp },
  { basePath: "/api/v1", app: webhooksAdminApp },
  { basePath: "/api/v1", app: webhookEndpointsAdminApp },
  { basePath: "/api/v1", app: lapsAdminApp },
  { basePath: "/api/v1", app: bitlockerAdminApp },
  { basePath: "/api/v1", app: devicePoliciesAdminApp },
  { basePath: "/api/v1", app: firewallAdminApp },
  { basePath: "/api/v1", app: kioskAdminApp },
  { basePath: "/api/v1", app: geofencesAdminApp },
];

/**
 * MDM 協議層（設備 OS 直連）：/EnrollmentServer/* + /api/mdm/win/*。
 * 非 OpenAPI 文檔化（SOAP / SyncML），掛在 root。歸 Control 服務。
 */
export const protocolMounts: Mount[] = [{ basePath: "/", app: windowsMdm }];

/** Agent Telemetry API（設備端上報，`/api/v1/tenants/{tid}/agent/*`）。 */
export const agentMounts: Mount[] = [{ basePath: "/api/v1", app: agentApp }];

/** Control 服務 = Control API + MDM 協議層。 */
export const controlServiceMounts: Mount[] = [...controlApiMounts, ...protocolMounts];

/** 單體（monolith）= 全部掛載。 */
export const monolithMounts: Mount[] = [
  ...controlApiMounts,
  ...agentMounts,
  ...protocolMounts,
];
