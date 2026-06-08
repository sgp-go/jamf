import Foundation
import UIKit

/// 收集當前裝置的狀態資訊
final class StatusCollector {
    static let shared = StatusCollector()
    private init() {}

    /// 收集裝置當前狀態
    func collect() -> DeviceStatus {
        UIDevice.current.isBatteryMonitoringEnabled = true

        let batteryLevel = Int(UIDevice.current.batteryLevel * 100)
        let batteryState = batteryStateString(UIDevice.current.batteryState)

        let (availableMb, totalMb) = storageInfo()

        return DeviceStatus(
            batteryLevel: max(batteryLevel, 0),
            batteryState: batteryState,
            storageAvailableMb: availableMb,
            storageTotalMb: totalMb,
            networkType: networkType(),
            networkSsid: nil, // 需要 NEHotspotNetwork entitlement（許可權）
            screenBrightness: Double(UIScreen.main.brightness),
            osVersion: UIDevice.current.systemVersion,
            deviceModel: modelIdentifier(),
            deviceName: UIDevice.current.name,
            appVersion: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0"
        )
    }

    private func batteryStateString(_ state: UIDevice.BatteryState) -> String {
        switch state {
        case .charging: return "charging"
        case .full: return "full"
        case .unplugged: return "unplugged"
        case .unknown: return "unknown"
        @unknown default: return "unknown"
        }
    }

    private func storageInfo() -> (availableMb: Int, totalMb: Int) {
        do {
            let attrs = try FileManager.default.attributesOfFileSystem(
                forPath: NSHomeDirectory()
            )
            let total = (attrs[.systemSize] as? Int64) ?? 0
            let free = (attrs[.systemFreeSize] as? Int64) ?? 0
            return (Int(free / 1_048_576), Int(total / 1_048_576))
        } catch {
            return (0, 0)
        }
    }

    private func networkType() -> String {
        // 簡化實現：透過檢查是否能存取網路判斷
        // 更精確的實現需要 NWPathMonitor
        return "WiFi"
    }

    private func modelIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        return withUnsafePointer(to: &systemInfo.machine) {
            $0.withMemoryRebound(to: CChar.self, capacity: 1) {
                String(validatingUTF8: $0) ?? "unknown"
            }
        }
    }
}
