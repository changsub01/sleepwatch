import SwiftUI

struct RootView: View {
    @EnvironmentObject private var sessionManager: SessionManager

    var body: some View {
        Group {
            if sessionManager.isMonitoring {
                MonitoringView()
            } else {
                IdleView()
            }
        }
        .animation(.default, value: sessionManager.isMonitoring)
    }
}
