import Foundation
import Network

/// 持續追蹤當前對外網路介面類型，供 `StatusCollector` 同步讀取。
///
/// `NWPathMonitor` 的 path 更新在背景佇列非同步回呼，故快取最新類型並以 lock 保護，
/// 讓採集端可在任意執行緒同步取值。取值約定與 Windows Agent 對齊（`"WiFi"` / `"Ethernet"`）。
final class NetworkMonitor {
    static let shared = NetworkMonitor()

    private let monitor = NWPathMonitor()
    private let queue = DispatchQueue(label: "com.cogrow.agent.network-monitor")
    private let lock = NSLock()
    private var cachedType = "Unknown"

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            self?.update(with: path)
        }
        monitor.start(queue: queue)
        update(with: monitor.currentPath)
    }

    /// 當前網路類型：`WiFi` / `Cellular` / `Ethernet` / `None` / `Unknown`。
    var currentType: String {
        lock.lock()
        defer { lock.unlock() }
        return cachedType
    }

    private func update(with path: NWPath) {
        let type: String
        if path.status != .satisfied {
            type = "None"
        } else if path.usesInterfaceType(.wifi) {
            type = "WiFi"
        } else if path.usesInterfaceType(.cellular) {
            type = "Cellular"
        } else if path.usesInterfaceType(.wiredEthernet) {
            type = "Ethernet"
        } else {
            type = "Unknown"
        }
        lock.lock()
        cachedType = type
        lock.unlock()
    }
}
