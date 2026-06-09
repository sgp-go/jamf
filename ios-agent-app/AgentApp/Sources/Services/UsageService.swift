import Foundation
import DeviceGuardKit

/// 管理 DeviceGuardKit 使用時長資料的上報
final class UsageService {
    static let shared = UsageService()

    private var serialNumber: String {
        ReportService.shared.serialNumber
    }

    private init() {}

    /// 處理待上報事件並上傳到伺服器
    func uploadUsageStats() async throws {
        guard DGKUsageStatsManager.shared.shouldPerformUpload() else { return }

        guard let statsRequest = await DGKUsageStatsManager.shared.processPendingEvents() else {
            return
        }

        let payload = UsageUploadPayload(
            serialNumber: serialNumber,
            sessionId: statsRequest.sessionId,
            stats: statsRequest.stats.map { item in
                UsageStatItem(
                    date: item.date,
                    totalMinutes: item.totalMinutes,
                    pickup: item.pickup,
                    maxContinuous: item.maxContinuous,
                    // 對齊後端 Record<string, number>：時段標籤 → 分鐘數
                    timeStats: item.timeStats.map { tsList in
                        Dictionary(tsList.map { (String($0.tag), $0.minutes) }, uniquingKeysWith: { _, last in last })
                    }
                )
            }
        )

        guard let url = ReportService.shared.agentEndpoint("usage") else {
            throw ReportError.missingTenant
        }

        let request = ReportService.shared.makeAgentRequest(
            url: url,
            body: try JSONEncoder().encode(payload)
        )

        let (_, response) = try await URLSession.shared.data(for: request)
        guard let httpResponse = response as? HTTPURLResponse,
              (200...299).contains(httpResponse.statusCode) else {
            throw ReportError.serverError
        }

        DGKUsageStatsManager.shared.recordSuccessfulUpload()
    }
}
