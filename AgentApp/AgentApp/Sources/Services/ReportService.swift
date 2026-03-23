import Foundation
import UIKit

/// 向管理平臺傳送裝置狀態回報
final class ReportService {
    static let shared = ReportService()

    /// 管理平臺 API 地址（可透過 MDM Config Profile 配置）
    var serverURL: String {
        get { UserDefaults.standard.string(forKey: "serverURL") ?? "http://localhost:3000" }
        set { UserDefaults.standard.set(newValue, forKey: "serverURL") }
    }

    /// 裝置 ID（Jamf 分配，可透過 MDM Config Profile 配置）
    var deviceId: String {
        get { UserDefaults.standard.string(forKey: "deviceId") ?? UIDevice.current.identifierForVendor?.uuidString ?? "unknown" }
        set { UserDefaults.standard.set(newValue, forKey: "deviceId") }
    }

    /// 序列號（實際需從裝置獲取，此處使用 placeholder）
    var serialNumber: String {
        get { UserDefaults.standard.string(forKey: "serialNumber") ?? "unknown" }
        set { UserDefaults.standard.set(newValue, forKey: "serialNumber") }
    }

    private init() {}

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

        guard let url = URL(string: "\(serverURL)/api/agent/report") else {
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
    }
}

enum ReportError: LocalizedError {
    case invalidURL
    case serverError

    var errorDescription: String? {
        switch self {
        case .invalidURL: return "Invalid server URL"
        case .serverError: return "Server returned an error"
        }
    }
}
