import Foundation

/// 使用時長上報 Payload（serialNumber 為後端設備標識，必填）
struct UsageUploadPayload: Codable {
    let serialNumber: String
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
    /// 時段分佈：key=時段標籤（如小時），value=分鐘數（對齊後端 Record<string, number>）
    let timeStats: [String: Int]?
}

/// 查詢響應
struct UsageQueryResponse: Codable {
    let stats: [UsageStatItem]
}
