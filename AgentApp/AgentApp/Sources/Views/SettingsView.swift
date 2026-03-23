import SwiftUI

struct SettingsView: View {
    @EnvironmentObject var manager: StatusManager
    @Environment(\.dismiss) private var dismiss

    @State private var serverURL: String = ""
    @State private var deviceId: String = ""
    @State private var serialNumber: String = ""

    var body: some View {
        NavigationStack {
            Form {
                Section("Server") {
                    TextField("Server URL", text: $serverURL)
                        .textContentType(.URL)
                        .autocapitalization(.none)
                        .keyboardType(.URL)
                }

                Section("Device") {
                    TextField("Device ID", text: $deviceId)
                        .autocapitalization(.none)
                    TextField("Serial Number", text: $serialNumber)
                        .autocapitalization(.allCharacters)
                }

                Section("Auto Report") {
                    Button("Start (every 5 min)") {
                        manager.startPeriodicReporting(intervalMinutes: 5)
                    }
                    Button("Stop") {
                        manager.stopPeriodicReporting()
                    }
                    .foregroundStyle(.red)
                }

                Section("Info") {
                    LabeledContent("App Version",
                        value: Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "1.0.0")
                    LabeledContent("Reports Sent", value: "\(manager.reportCount)")
                }
            }
            .navigationTitle("Settings")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") {
                        save()
                        dismiss()
                    }
                }
            }
            .onAppear {
                serverURL = manager.serverURL
                deviceId = manager.deviceId
                serialNumber = manager.serialNumber
            }
        }
    }

    private func save() {
        manager.serverURL = serverURL
        manager.deviceId = deviceId
        manager.serialNumber = serialNumber
    }
}
