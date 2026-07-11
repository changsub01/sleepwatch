import Foundation
import SwiftData

@Model
final class SleepSession {
    var startTime: Date
    var endTime: Date?

    @Relationship(deleteRule: .cascade, inverse: nil)
    var events: [SleepEvent]

    init(startTime: Date, endTime: Date? = nil, events: [SleepEvent] = []) {
        self.startTime = startTime
        self.endTime = endTime
        self.events = events
    }

    var duration: TimeInterval {
        (endTime ?? Date()).timeIntervalSince(startTime)
    }

    var isActive: Bool {
        endTime == nil
    }
}
