import Foundation
import DeviceGuardKit

/// 管理 DeviceGuardKit 使用時長資料的上報
final class UsageService {
    static let shared = UsageService()

    private var serverURL: String {
        ReportService.shared.serverURL
    }

    private var deviceId: String {
        ReportService.shared.deviceId
    }

    private init() {}

    /// 處理待上報事件並上傳到伺服器
    func uploadUsageStats() async throws {
        guard DGKUsageStatsManager.shared.shouldPerformUpload() else { return }

        guard let statsRequest = await DGKUsageStatsManager.shared.processPendingEvents() else {
            return
        }

        let payload = UsageUploadPayload(
            deviceId: deviceId,
            sessionId: statsRequest.sessionId,
            stats: statsRequest.stats.map { item in
                UsageStatItem(
                    date: item.date,
                    totalMinutes: item.totalMinutes,
                    pickup: item.pickup,
                    maxContinuous: item.maxContinuous,
                    timeStats: item.timeStats?.map { ts in
                        TimeStatItem(hour: Int(ts.tag) ?? 0, minutes: ts.minutes)
                    }
                )
            }
        )

        guard let url = URL(string: "\(serverURL)/api/agent/usage") else {
            throw ReportError.invalidURL
        }

        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(payload)
        request.timeoutInterval = 30

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw ReportError.serverError
        }

        DGKUsageStatsManager.shared.recordSuccessfulUpload()
    }
}
