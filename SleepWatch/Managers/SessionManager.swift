import Foundation
import SwiftData
import UIKit

@MainActor
final class SessionManager: ObservableObject {
    @Published private(set) var currentSession: SleepSession?
    @Published private(set) var currentTime: Date = Date()
    @Published var permissionDenied = false

    private let detector = SoundDetector()
    private var clockTimer: Timer?
    private var autoStopTimer: Timer?
    private var modelContext: ModelContext?

    var isMonitoring: Bool { currentSession != nil }

    var elapsed: TimeInterval {
        guard let session = currentSession else { return 0 }
        return currentTime.timeIntervalSince(session.startTime)
    }

    func configure(modelContext: ModelContext) {
        self.modelContext = modelContext
    }

    func start(autoStopAfter duration: TimeInterval) {
        guard currentSession == nil else { return }

        detector.requestPermission { [weak self] granted in
            guard let self else { return }
            guard granted else {
                self.permissionDenied = true
                return
            }
            self.beginSession(autoStopAfter: duration)
        }
    }

    private func beginSession(autoStopAfter duration: TimeInterval) {
        let session = SleepSession(startTime: Date())
        modelContext?.insert(session)
        currentSession = session
        currentTime = session.startTime

        detector.onEvent = { [weak self] timestamp, level in
            self?.recordEvent(timestamp: timestamp, level: level)
        }

        do {
            try detector.start()
        } catch {
            currentSession = nil
            permissionDenied = true
            return
        }

        UIApplication.shared.isIdleTimerDisabled = true

        clockTimer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.currentTime = Date() }
        }

        if duration > 0 {
            autoStopTimer = Timer.scheduledTimer(withTimeInterval: duration, repeats: false) { [weak self] _ in
                Task { @MainActor in self?.stop() }
            }
        }
    }

    private func recordEvent(timestamp: Date, level: Float) {
        guard let session = currentSession else { return }
        let event = SleepEvent(timestamp: timestamp, level: level)
        modelContext?.insert(event)
        session.events.append(event)
    }

    func stop() {
        guard let session = currentSession else { return }

        detector.stop()
        clockTimer?.invalidate()
        clockTimer = nil
        autoStopTimer?.invalidate()
        autoStopTimer = nil
        UIApplication.shared.isIdleTimerDisabled = false

        session.endTime = Date()
        try? modelContext?.save()

        currentSession = nil
    }
}
