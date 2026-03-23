import SwiftUI
import BackgroundTasks
import DeviceGuardKit
import FamilyControls

@main
struct AgentAppApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) var appDelegate
    @StateObject private var statusManager = StatusManager()

    var body: some Scene {
        WindowGroup {
            DashboardView()
                .environmentObject(statusManager)
                .onAppear {
                    registerBackgroundTasks()
                }
        }
    }

    private func registerBackgroundTasks() {
        BGTaskScheduler.shared.register(
            forTaskWithIdentifier: AppConstants.bgTaskIdentifier,
            using: nil
        ) { task in
            guard let bgTask = task as? BGAppRefreshTask else { return }
            handleStatusReport(task: bgTask)
        }
        scheduleNextReport()
    }

    private func handleStatusReport(task: BGAppRefreshTask) {
        Task {
            do {
                try await ReportService.shared.sendReport()
                try await UsageService.shared.uploadUsageStats()
                task.setTaskCompleted(success: true)
            } catch {
                task.setTaskCompleted(success: false)
            }
            scheduleNextReport()
        }

        task.expirationHandler = {
            task.setTaskCompleted(success: false)
        }
    }

    private func scheduleNextReport() {
        let request = BGAppRefreshTaskRequest(identifier: AppConstants.bgTaskIdentifier)
        request.earliestBeginDate = Date(timeIntervalSinceNow: 15 * 60)
        do {
            try BGTaskScheduler.shared.submit(request)
        } catch {
            print("Failed to schedule background task: \(error)")
        }
    }
}

/// AppDelegate 負責 DeviceGuardKit 初始化和裝置解鎖記錄
class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        setupDeviceGuardKit()
        return true
    }

    private func setupDeviceGuardKit() {
        DGKConfiguration.configure(
            appGroupIdentifier: AppConstants.appGroupIdentifier,
            logSubsystem: Bundle.main.bundleIdentifier ?? AppConstants.appGroupIdentifier
        )

        DGKConfiguration.shared.onStatsReadyForUpload = { _ in
            do {
                try await UsageService.shared.uploadUsageStats()
                return true
            } catch {
                print("Usage upload failed: \(error)")
                return false
            }
        }

        Task {
            do {
                try await AuthorizationCenter.shared.requestAuthorization(for: .individual)
                print("[AgentApp] FamilyControls 授權成功")
                DGKDeviceControlManager.shared.startUsageMonitoring()
            } catch {
                print("[AgentApp] FamilyControls 授權失敗: \(error)")
            }
        }
    }

    func applicationProtectedDataDidBecomeAvailable(_ application: UIApplication) {
        DGKUsageStatsManager.shared.recordDeviceUnlock()
    }
}
