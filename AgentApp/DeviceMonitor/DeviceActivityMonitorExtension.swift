import DeviceActivity
import DeviceGuardKitExtension

class DeviceActivityMonitorExtension: DeviceActivityMonitor {
    // MARK: - 甲方請修改此 App Group ID（需與主應用 AppConstants.appGroupIdentifier 一致）
    private let appGroupIdentifier = "group.com.aspira.agent.app"

    override init() {
        super.init()
        DGKExtensionHandler.configure(appGroupIdentifier: appGroupIdentifier)
    }

    override func intervalDidStart(for activity: DeviceActivityName) {
        super.intervalDidStart(for: activity)
        DGKExtensionHandler.shared.handleIntervalStart(activity: activity)
    }

    override func intervalDidEnd(for activity: DeviceActivityName) {
        super.intervalDidEnd(for: activity)
        DGKExtensionHandler.shared.handleIntervalEnd(activity: activity)
    }

    override func eventDidReachThreshold(
        _ event: DeviceActivityEvent.Name,
        activity: DeviceActivityName
    ) {
        super.eventDidReachThreshold(event, activity: activity)
        DGKExtensionHandler.shared.handleThresholdReached(event: event, activity: activity)
    }

    override func intervalWillEndWarning(for activity: DeviceActivityName) {
        super.intervalWillEndWarning(for: activity)
        DGKExtensionHandler.shared.handleIntervalEndWarning(activity: activity)
    }

    override func eventWillReachThresholdWarning(
        _ event: DeviceActivityEvent.Name,
        activity: DeviceActivityName
    ) {
        super.eventWillReachThresholdWarning(event, activity: activity)
        DGKExtensionHandler.shared.handleThresholdWarning(event: event, activity: activity)
    }
}
