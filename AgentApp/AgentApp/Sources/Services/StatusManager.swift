import Foundation
import Combine
import DeviceGuardKit

/// 管理裝置狀態收集和回報的 ViewModel
@MainActor
final class StatusManager: ObservableObject {
    @Published var currentStatus: DeviceStatus?
    @Published var lastReportTime: Date?
    @Published var isReporting = false
    @Published var lastError: String?
    @Published var reportCount = 0
    @Published var todayUsageMinutes = 0
    @Published var todayPickupCount = 0

    private var timer: Timer?
    private let collector = StatusCollector.shared
    private let reporter = ReportService.shared

    /// 重新整理當前裝置狀態和使用統計
    func refreshStatus() {
        currentStatus = collector.collect()
        Task {
            await refreshUsageStats()
        }
    }

    /// 立即傳送一次回報（裝置狀態 + 使用時長）
    func sendReport() async {
        isReporting = true
        lastError = nil
        do {
            try await reporter.sendReport()
            try await UsageService.shared.uploadUsageStats()
            lastReportTime = Date()
            reportCount += 1
        } catch {
            lastError = error.localizedDescription
        }
        isReporting = false
    }

    /// 開啟定時回報（前臺模式）
    func startPeriodicReporting(intervalMinutes: Int = 5) {
        stopPeriodicReporting()
        timer = Timer.scheduledTimer(withTimeInterval: TimeInterval(intervalMinutes * 60), repeats: true) { [weak self] _ in
            Task { @MainActor [weak self] in
                await self?.sendReport()
            }
        }
    }

    /// 停止定時回報
    func stopPeriodicReporting() {
        timer?.invalidate()
        timer = nil
    }

    /// 伺服器地址
    var serverURL: String {
        get { reporter.serverURL }
        set { reporter.serverURL = newValue }
    }

    var deviceId: String {
        get { reporter.deviceId }
        set { reporter.deviceId = newValue }
    }

    var serialNumber: String {
        get { reporter.serialNumber }
        set { reporter.serialNumber = newValue }
    }

    /// 重新整理今日使用時長統計
    func refreshUsageStats() async {
        // 先處理 Extension 待處理事件，將其轉換為歷史統計
        _ = await DGKUsageStatsManager.shared.processPendingEvents()

        let formatter = DateFormatter()
        formatter.dateFormat = "yyyy-MM-dd"
        let today = formatter.string(from: Date())

        let stats = DGKUsageStatsManager.shared.getAllHistoricalStats()
        if let todayStats = stats.first(where: { $0.date == today }) {
            todayUsageMinutes = todayStats.totalMinutes
        } else {
            todayUsageMinutes = 0
        }

        // 解鎖次數單獨儲存，直接讀取而不依賴歷史統計
        todayPickupCount = DGKUsageStatsManager.shared.getUnlockCount(for: today)
    }

    /// 手動上報使用時長
    func uploadUsageStats() async {
        isReporting = true
        lastError = nil
        do {
            try await UsageService.shared.uploadUsageStats()
        } catch {
            lastError = error.localizedDescription
        }
        isReporting = false
    }
}
