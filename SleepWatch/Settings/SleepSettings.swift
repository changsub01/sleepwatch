import Foundation

enum SleepSettings {
    /// Stored in hours; 0 means "no auto-stop, manual only".
    static let autoStopHoursKey = "autoStopHours"
    static let defaultAutoStopHours: Double = 8
}
