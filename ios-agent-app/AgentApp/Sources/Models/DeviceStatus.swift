import Foundation
import UIKit

/// 裝置狀態資料模型
struct DeviceStatus: Codable, Identifiable {
    var id = UUID()
    let batteryLevel: Int
    let batteryState: String
    let storageAvailableMb: Int
    let storageTotalMb: Int
    let networkType: String
    let networkSsid: String?
    let screenBrightness: Double
    let osVersion: String
    let deviceModel: String
    let deviceName: String
    let appVersion: String
    let collectedAt: Date

    enum CodingKeys: String, CodingKey {
        case batteryLevel, batteryState
        case storageAvailableMb, storageTotalMb
        case networkType, networkSsid
        case screenBrightness, osVersion
        case deviceModel, deviceName
        case appVersion, collectedAt
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.batteryLevel = try container.decode(Int.self, forKey: .batteryLevel)
        self.batteryState = try container.decode(String.self, forKey: .batteryState)
        self.storageAvailableMb = try container.decode(Int.self, forKey: .storageAvailableMb)
        self.storageTotalMb = try container.decode(Int.self, forKey: .storageTotalMb)
        self.networkType = try container.decode(String.self, forKey: .networkType)
        self.networkSsid = try container.decodeIfPresent(String.self, forKey: .networkSsid)
        self.screenBrightness = try container.decode(Double.self, forKey: .screenBrightness)
        self.osVersion = try container.decode(String.self, forKey: .osVersion)
        self.deviceModel = try container.decode(String.self, forKey: .deviceModel)
        self.deviceName = try container.decode(String.self, forKey: .deviceName)
        self.appVersion = try container.decode(String.self, forKey: .appVersion)
        self.collectedAt = try container.decode(Date.self, forKey: .collectedAt)
    }

    init(
        batteryLevel: Int,
        batteryState: String,
        storageAvailableMb: Int,
        storageTotalMb: Int,
        networkType: String,
        networkSsid: String?,
        screenBrightness: Double,
        osVersion: String,
        deviceModel: String,
        deviceName: String,
        appVersion: String,
        collectedAt: Date = Date()
    ) {
        self.batteryLevel = batteryLevel
        self.batteryState = batteryState
        self.storageAvailableMb = storageAvailableMb
        self.storageTotalMb = storageTotalMb
        self.networkType = networkType
        self.networkSsid = networkSsid
        self.screenBrightness = screenBrightness
        self.osVersion = osVersion
        self.deviceModel = deviceModel
        self.deviceName = deviceName
        self.appVersion = appVersion
        self.collectedAt = collectedAt
    }
}

/// 傳送到伺服器的回報 payload
struct AgentReportPayload: Codable {
    let deviceId: String
    let serialNumber: String
    let batteryLevel: Int
    let storageAvailableMb: Int
    let storageTotalMb: Int
    let networkType: String
    let networkSsid: String?
    let screenBrightness: Double
    let osVersion: String
    let appVersion: String
    let reportedAt: String
}
