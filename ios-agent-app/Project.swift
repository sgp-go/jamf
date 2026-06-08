import ProjectDescription

// ── 專案標識符（甲方請修改此處） ──
let organizationName = "Aspira"
let mainBundleId = "com.aspira.agent.app"
let extensionBundleId = "\(mainBundleId).devicemonitor"
let appGroupId = "group.\(mainBundleId)"
let bgTaskId = "\(mainBundleId).statusReport"
let developmentTeam = "UK774VN48M"
let displayName = "Aspira Agent"

let project = Project(
    name: "AgentApp",
    organizationName: organizationName,
    settings: .settings(
        base: [
            "DEVELOPMENT_TEAM": "\(developmentTeam)",
            "CODE_SIGN_STYLE": "Manual",
        ]
    ),
    targets: [
        .target(
            name: "AgentApp",
            destinations: [.iPad, .iPhone],
            product: .app,
            bundleId: mainBundleId,
            deploymentTargets: .iOS("17.0"),
            infoPlist: .extendingDefault(with: [
                "UILaunchScreen": [
                    "UIColorName": "",
                    "UIImageName": "",
                ],
                "UIBackgroundModes": .array(["fetch", "processing"]),
                "BGTaskSchedulerPermittedIdentifiers": .array([
                    "\(bgTaskId)",
                ]),
                "CFBundleDisplayName": "\(displayName)",
                "UISupportedInterfaceOrientations~ipad": .array([
                    "UIInterfaceOrientationPortrait",
                    "UIInterfaceOrientationLandscapeLeft",
                    "UIInterfaceOrientationLandscapeRight",
                ]),
            ]),
            sources: ["AgentApp/Sources/**"],
            resources: ["AgentApp/Resources/**"],
            entitlements: .dictionary([
                "com.apple.security.application-groups": .array([.string(appGroupId)]),
                "com.apple.developer.family-controls": .boolean(true),
            ]),
            dependencies: [
                .xcframework(path: "Frameworks/DeviceGuardKit.xcframework"),
                .target(name: "DeviceMonitor"),
            ],
            settings: .settings(base: [
                "PROVISIONING_PROFILE_SPECIFIER": "match Development \(mainBundleId)",
            ])
        ),
        .target(
            name: "DeviceMonitor",
            destinations: [.iPad, .iPhone],
            product: .appExtension,
            bundleId: extensionBundleId,
            deploymentTargets: .iOS("17.0"),
            infoPlist: .extendingDefault(with: [
                "CFBundleDisplayName": "Device Monitor",
                "NSExtension": [
                    "NSExtensionPointIdentifier": "com.apple.deviceactivity.monitor-extension",
                    "NSExtensionPrincipalClass": "$(PRODUCT_MODULE_NAME).DeviceActivityMonitorExtension",
                ],
            ]),
            sources: ["DeviceMonitor/**"],
            entitlements: .dictionary([
                "com.apple.security.application-groups": .array([.string(appGroupId)]),
                "com.apple.developer.family-controls": .boolean(true),
            ]),
            dependencies: [
                .xcframework(path: "Frameworks/DeviceGuardKit.xcframework"),
                .xcframework(path: "Frameworks/DeviceGuardKitExtension.xcframework"),
            ],
            settings: .settings(base: [
                "PROVISIONING_PROFILE_SPECIFIER": "match Development \(extensionBundleId)",
            ])
        ),
    ]
)
