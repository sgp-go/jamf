import SwiftUI

struct DashboardView: View {
    @EnvironmentObject var manager: StatusManager
    @State private var showSettings = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    // 狀態卡片
                    if let status = manager.currentStatus {
                        StatusCardView(status: status)
                    } else {
                        ContentUnavailableView(
                            "Loading...",
                            systemImage: "ipad.and.arrow.forward",
                            description: Text("Collecting device status")
                        )
                    }

                    // 使用時長
                    UsageStatsCardView()

                    // 回報狀態
                    ReportStatusView()

                    // 操作按鈕
                    ActionButtonsView()
                }
                .padding()
            }
            .navigationTitle("CoGrow Agent")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        showSettings = true
                    } label: {
                        Image(systemName: "gear")
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button {
                        manager.refreshStatus()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                }
            }
            .sheet(isPresented: $showSettings) {
                SettingsView()
            }
        }
        .onAppear {
            manager.refreshStatus()
        }
    }
}

// MARK: - 狀態卡片

struct StatusCardView: View {
    let status: DeviceStatus

    var body: some View {
        VStack(spacing: 16) {
            // 裝置資訊頭
            HStack {
                Image(systemName: "ipad")
                    .font(.title)
                    .foregroundStyle(.blue)
                VStack(alignment: .leading) {
                    Text(status.deviceName)
                        .font(.headline)
                    Text("iPadOS \(status.osVersion) • \(status.deviceModel)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
            }

            Divider()

            // 電池
            InfoRow(
                icon: batteryIcon,
                iconColor: batteryColor,
                title: "Battery",
                value: "\(status.batteryLevel)% (\(status.batteryState))"
            )

            // 儲存
            InfoRow(
                icon: "internaldrive",
                iconColor: .orange,
                title: "Storage",
                value: "\(status.storageAvailableMb / 1024)GB / \(status.storageTotalMb / 1024)GB free"
            )

            // 網路
            InfoRow(
                icon: "wifi",
                iconColor: .green,
                title: "Network",
                value: "\(status.networkType)\(status.networkSsid.map { " (\($0))" } ?? "")"
            )

            // 亮度
            InfoRow(
                icon: "sun.max",
                iconColor: .yellow,
                title: "Brightness",
                value: "\(Int(status.screenBrightness * 100))%"
            )
        }
        .padding()
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }

    private var batteryIcon: String {
        if status.batteryLevel > 75 { return "battery.100" }
        if status.batteryLevel > 50 { return "battery.75" }
        if status.batteryLevel > 25 { return "battery.50" }
        return "battery.25"
    }

    private var batteryColor: Color {
        if status.batteryLevel > 50 { return .green }
        if status.batteryLevel > 20 { return .orange }
        return .red
    }
}

// MARK: - 資訊列

struct InfoRow: View {
    let icon: String
    let iconColor: Color
    let title: String
    let value: String

    var body: some View {
        HStack {
            Image(systemName: icon)
                .foregroundStyle(iconColor)
                .frame(width: 24)
            Text(title)
                .foregroundStyle(.secondary)
            Spacer()
            Text(value)
                .fontWeight(.medium)
        }
    }
}

// MARK: - 使用時長卡片

struct UsageStatsCardView: View {
    @EnvironmentObject var manager: StatusManager

    var body: some View {
        VStack(spacing: 12) {
            HStack {
                Image(systemName: "clock.fill")
                    .foregroundStyle(.purple)
                Text("Usage Today")
                    .font(.headline)
                Spacer()
            }

            HStack {
                VStack {
                    Text("\(manager.todayUsageMinutes)")
                        .font(.title)
                        .fontWeight(.bold)
                    Text("Minutes")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)

                Divider().frame(height: 40)

                VStack {
                    Text("\(manager.todayPickupCount)")
                        .font(.title)
                        .fontWeight(.bold)
                    Text("Pickups")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(maxWidth: .infinity)
            }
        }
        .padding()
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16))
        .task { await manager.refreshUsageStats() }
    }
}

// MARK: - 回報狀態

struct ReportStatusView: View {
    @EnvironmentObject var manager: StatusManager

    var body: some View {
        VStack(spacing: 8) {
            HStack {
                Image(systemName: "arrow.up.circle")
                    .foregroundStyle(.blue)
                Text("Report Status")
                    .font(.headline)
                Spacer()
            }

            HStack {
                Text("Reports sent:")
                Spacer()
                Text("\(manager.reportCount)")
                    .fontWeight(.medium)
            }

            if let lastTime = manager.lastReportTime {
                HStack {
                    Text("Last report:")
                    Spacer()
                    Text(lastTime, style: .relative)
                        .fontWeight(.medium)
                }
            }

            if let error = manager.lastError {
                HStack {
                    Image(systemName: "exclamationmark.triangle")
                        .foregroundStyle(.red)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.red)
                    Spacer()
                }
            }
        }
        .padding()
        .background(.regularMaterial)
        .clipShape(RoundedRectangle(cornerRadius: 16))
    }
}

// MARK: - 操作按鈕

struct ActionButtonsView: View {
    @EnvironmentObject var manager: StatusManager

    var body: some View {
        VStack(spacing: 12) {
            Button {
                Task { await manager.sendReport() }
            } label: {
                HStack {
                    if manager.isReporting {
                        ProgressView()
                            .tint(.white)
                    } else {
                        Image(systemName: "paperplane.fill")
                    }
                    Text(manager.isReporting ? "Sending..." : "Send Report Now")
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(.blue)
                .foregroundStyle(.white)
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
            .disabled(manager.isReporting)

            Button {
                manager.refreshStatus()
            } label: {
                HStack {
                    Image(systemName: "arrow.clockwise")
                    Text("Refresh Status")
                }
                .frame(maxWidth: .infinity)
                .padding()
                .background(.gray.opacity(0.15))
                .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
    }
}
