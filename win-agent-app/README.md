# CoGrow MDM Agent (Windows)

C# .NET 8 Windows Service that posts daily telemetry from managed Windows
devices to the CoGrow MDM platform. Distributed as a signed `.msi` via the
`install-agent` admin API and the EnterpriseDesktopAppManagement CSP.

## Status

W1-9 Day 1 scaffold: `dotnet build` + `dotnet test` pass on macOS, Linux,
and Windows. WiX `.msi` packaging and real-machine validation are Day 2
work (Windows-only).

## Layout

```
agent-app/
├── CoGrowMDMAgent.sln
└── src/
    ├── CoGrowMDMAgent/
    │   ├── Program.cs                     Generic Host + WindowsService + DI
    │   ├── Worker.cs                      BackgroundService main loop
    │   ├── Config/
    │   │   ├── AgentConfig.cs             Strongly-typed config record
    │   │   └── RegistryConfig.cs          HKLM loader + env-var dev fallback
    │   ├── Scheduling/
    │   │   └── JitterScheduler.cs         hash(device_id) % 300 → 00:00-05:00
    │   └── Reporting/
    │       ├── ReportSchema.cs            DTOs aligned with v1 OpenAPI
    │       ├── DeviceFactsCollector.cs    WMI + DriveInfo + WindowsIdentity
    │       ├── DeviceReporter.cs          POST /tenants/{tid}/agent/reports
    │       └── UsageReporter.cs           POST /tenants/{tid}/agent/usage
    └── CoGrowMDMAgent.Tests/              xUnit tests (17 green)
```

## Endpoints (v1, matches `app/routes/v1/agent.ts`)

- `POST {api_endpoint}/tenants/{tenant_id}/agent/reports`
- `POST {api_endpoint}/tenants/{tenant_id}/agent/usage`

Bearer auth is mandatory once `install-agent` has provisioned the device.

## Configuration source

`HKLM\SOFTWARE\Policies\CoGrowMDM\Agent` (written by the platform's
`install-agent` flow via Registry CSP):

| Value | Meaning |
|---|---|
| `device_id` | mdm_devices.id (UUID) |
| `agent_token` | Bearer token (32-byte hex) |
| `api_endpoint` | API base URL incl. `/api/v1` |
| `tenant_id` | Tenant UUID |

Dev fallback on non-Windows: env vars `COGROW_DEVICE_ID`,
`COGROW_AGENT_TOKEN`, `COGROW_API_ENDPOINT`, `COGROW_TENANT_ID`.

## Build & test

```bash
# macOS (.NET 8 from brew)
export PATH="/opt/homebrew/opt/dotnet@8/bin:$PATH"
cd agent-app
dotnet build
dotnet test
```

## Day 2 TODO (Windows-only)

- WiX v4 Installer project + `Product.wxs` + `Service.wxs`
- `build.ps1` + `sign.ps1` (self-signed dev cert)
- Real-machine round trip via `install-agent` API + 192.168.50.68
