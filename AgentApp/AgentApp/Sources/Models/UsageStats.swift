import Foundation

/// 使用時長上報 Payload
struct UsageUploadPayload: Codable {
    let deviceId: String
    let sessionId: String?
    let stats: [UsageStatItem]
}

/// 單日使用統計項
struct UsageStatItem: Codable, Identifiable {
    var id: String { date }
    let date: String
    let totalMinutes: Int
    let pickup: Int
    let maxContinuous: Int
    let timeStats: [TimeStatItem]?
}

/// 每小時統計
struct TimeStatItem: Codable {
    let hour: Int
    let minutes: Int
}

/// 查詢響應
struct UsageQueryResponse: Codable {
    let deviceId: String
    let stats: [UsageStatItem]
}
