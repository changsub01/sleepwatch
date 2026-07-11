import Foundation
import SwiftData

@Model
final class SleepEvent {
    var timestamp: Date
    var level: Float

    init(timestamp: Date, level: Float) {
        self.timestamp = timestamp
        self.level = level
    }
}
