import { relations } from "drizzle-orm";
import { agentReports, deviceUsageStats } from "./agent.ts";
import { asmInstances, depDevices, depTokens } from "./asm.ts";
import { mdmCommands, mdmDevices, mdmMigrations } from "./devices.ts";
import { jamfInstances, jamfTokenCache } from "./jamf.ts";
import { mdmDeviceCertificates, selfMdmConfigs } from "./self-mdm.ts";
import { deviceGroups, tenants } from "./tenants.ts";

export const tenantsRelations = relations(tenants, ({ many, one }) => ({
  deviceGroups: many(deviceGroups),
  jamfInstances: many(jamfInstances),
  asmInstances: many(asmInstances),
  devices: many(mdmDevices),
  selfMdmConfig: one(selfMdmConfigs),
}));

export const deviceGroupsRelations = relations(deviceGroups, ({ one, many }) => ({
  tenant: one(tenants, { fields: [deviceGroups.tenantId], references: [tenants.id] }),
  jamfInstance: one(jamfInstances, {
    fields: [deviceGroups.jamfInstanceId],
    references: [jamfInstances.id],
  }),
  devices: many(mdmDevices),
}));

export const jamfInstancesRelations = relations(jamfInstances, ({ one, many }) => ({
  tenant: one(tenants, { fields: [jamfInstances.tenantId], references: [tenants.id] }),
  tokenCache: one(jamfTokenCache),
  deviceGroup: one(deviceGroups), // 1:1，device_group 那邊持有 FK
  devices: many(mdmDevices),
}));

export const jamfTokenCacheRelations = relations(jamfTokenCache, ({ one }) => ({
  instance: one(jamfInstances, {
    fields: [jamfTokenCache.jamfInstanceId],
    references: [jamfInstances.id],
  }),
}));

export const asmInstancesRelations = relations(asmInstances, ({ one, many }) => ({
  tenant: one(tenants, { fields: [asmInstances.tenantId], references: [tenants.id] }),
  depTokens: many(depTokens),
  depDevices: many(depDevices),
}));

export const depTokensRelations = relations(depTokens, ({ one }) => ({
  asmInstance: one(asmInstances, {
    fields: [depTokens.asmInstanceId],
    references: [asmInstances.id],
  }),
}));

export const depDevicesRelations = relations(depDevices, ({ one }) => ({
  asmInstance: one(asmInstances, {
    fields: [depDevices.asmInstanceId],
    references: [asmInstances.id],
  }),
}));

export const selfMdmConfigsRelations = relations(selfMdmConfigs, ({ one, many }) => ({
  tenant: one(tenants, { fields: [selfMdmConfigs.tenantId], references: [tenants.id] }),
  certificates: many(mdmDeviceCertificates),
}));

export const mdmDeviceCertificatesRelations = relations(
  mdmDeviceCertificates,
  ({ one }) => ({
    selfMdmConfig: one(selfMdmConfigs, {
      fields: [mdmDeviceCertificates.selfMdmConfigId],
      references: [selfMdmConfigs.id],
    }),
  }),
);

export const mdmDevicesRelations = relations(mdmDevices, ({ one, many }) => ({
  tenant: one(tenants, { fields: [mdmDevices.tenantId], references: [tenants.id] }),
  deviceGroup: one(deviceGroups, {
    fields: [mdmDevices.deviceGroupId],
    references: [deviceGroups.id],
  }),
  jamfInstance: one(jamfInstances, {
    fields: [mdmDevices.jamfInstanceId],
    references: [jamfInstances.id],
  }),
  asmInstance: one(asmInstances, {
    fields: [mdmDevices.asmInstanceId],
    references: [asmInstances.id],
  }),
  selfMdmConfig: one(selfMdmConfigs, {
    fields: [mdmDevices.selfMdmConfigId],
    references: [selfMdmConfigs.id],
  }),
  commands: many(mdmCommands),
  reports: many(agentReports),
  usageStats: many(deviceUsageStats),
}));

export const mdmCommandsRelations = relations(mdmCommands, ({ one }) => ({
  device: one(mdmDevices, {
    fields: [mdmCommands.deviceId],
    references: [mdmDevices.id],
  }),
  tenant: one(tenants, { fields: [mdmCommands.tenantId], references: [tenants.id] }),
}));

export const mdmMigrationsRelations = relations(mdmMigrations, ({ one }) => ({
  device: one(mdmDevices, {
    fields: [mdmMigrations.deviceId],
    references: [mdmDevices.id],
  }),
  tenant: one(tenants, {
    fields: [mdmMigrations.tenantId],
    references: [tenants.id],
  }),
}));

export const agentReportsRelations = relations(agentReports, ({ one }) => ({
  device: one(mdmDevices, {
    fields: [agentReports.deviceId],
    references: [mdmDevices.id],
  }),
}));

export const deviceUsageStatsRelations = relations(deviceUsageStats, ({ one }) => ({
  device: one(mdmDevices, {
    fields: [deviceUsageStats.deviceId],
    references: [mdmDevices.id],
  }),
}));
