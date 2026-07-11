import SwiftUI
import SwiftData

@main
struct SleepWatchApp: App {
    @StateObject private var sessionManager = SessionManager()

    var sharedModelContainer: ModelContainer = {
        let schema = Schema([SleepSession.self, SleepEvent.self])
        let configuration = ModelConfiguration(schema: schema)
        do {
            return try ModelContainer(for: schema, configurations: [configuration])
        } catch {
            fatalError("SwiftData 컨테이너 생성 실패: \(error)")
        }
    }()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(sessionManager)
                .preferredColorScheme(.dark)
                .onAppear {
                    sessionManager.configure(modelContext: sharedModelContainer.mainContext)
                }
        }
        .modelContainer(sharedModelContainer)
    }
}
