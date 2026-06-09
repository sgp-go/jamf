import Foundation
import UIKit

/// 向管理平臺傳送裝置狀態回報
final class ReportService {
    static let shared = ReportService()

    /// 從 Jamf Managed App Configuration 讀取值，取不到再 fallback 到手動設定
    private func managedValue(forKey key: String) -> String? {
        UserDefaults.standard.dictionary(forKey: "com.apple.configuration.managed")?[key] as? String
    }

    /// 管理平臺 API 地址（優先從 Managed App Configuration 讀取）
    var serverURL: String {
        get { managedValue(forKey: "serverURL") ?? UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3000" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }

    /// 裝置 ID（優先從 Managed App Configuration 讀取）
    var deviceId: String {
        get { managedValue(forKey: "deviceId") ?? UserDefaults.standard.string(forKey: "deviceId") ?? UIDevice.current.identifierForVendor?.uuidString ?? "unknown" }
        set { UserDefaults.standard.set(newValue, forKey: "deviceId") }
    }

    /// 序列號（優先從 Managed App Configuration 讀取）
    var serialNumber: String {
        get { managedValue(forKey: "serialNumber") ?? UserDefaults.standard.string(forKey: "serialNumber") ?? "unknown" }
        set { UserDefaults.standard.set(newValue, forKey: "serialNumber") }
    }

    /// 租戶 ID（多租戶 API 路徑必需，由 MDM 透過 Managed App Configuration 注入）
    var tenantId: String {
        get { managedValue(forKey: "tenantId") ?? UserDefaults.standard.string(forKey: "tenantId") ?? "" }
        set { UserDefaults.standard.set(newValue, forKey: "tenantId") }
    }

    private init() {}

    /// 構建多租戶 Agent API 端點：`{serverURL}/api/v1/tenants/{tenantId}/agent/{suffix}`。
    /// tenantId 缺失時回 nil，呼叫端應拋 `ReportError.missingTenant`。
    func agentEndpoint(_ suffix: String) -> URL? {
        let tid = tenantId
        guard !tid.isEmpty else { return nil }
        return URL(string: "\(serverURL)/api/v1/tenants/\(tid)/agent/\(suffix)")
    }

    /// 收集狀態併發送到伺服器
    func sendReport() async throws {
        let status = StatusCollector.shared.collect()

        let payload = AgentReportPayload(
            deviceId: deviceId,
            serialNumber: serialNumber,
            batteryLevel: status.batteryLevel,
            storageAvailableMb: status.storageAvailableMb,
            storageTotalMb: status.storageTotalMb,
            networkType: status.networkType,
            networkSsid: status.networkSsid,
            screenBrightness: status.screenBrightness,
            osVersion: status.osVersion,
            appVersion: status.appVersion,
            reportedAt: ISO8601DateFormatter().string(from: Date())
        )

        guard let url = agentEndpoint("reports") else {
            throw ReportError.missingTenant
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
    }
}

enum ReportError: LocalizedError {
    case invalidURL
    case missingTenant
    case serverError

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case .missingTenant: return "tenantId 未配置（需 MDM 透過 Managed App Configuration 注入）"
        case .serverError: return "Server returned an error"
        }
    }
}
