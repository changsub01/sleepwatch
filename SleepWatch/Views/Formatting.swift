import Foundation

enum SleepFormat {
    static let clock: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "HH:mm:ss"
        return f
    }()

    static let dayTime: DateFormatter = {
        let f = DateFormatter()
        f.dateFormat = "M/d(E) HH:mm"
        f.locale = Locale(identifier: "ko_KR")
        return f
    }()

    static func duration(_ interval: TimeInterval) -> String {
        let total = Int(interval)
        let h = total / 3600
        let m = (total % 3600) / 60
        let s = total % 60
        return String(format: "%02d:%02d:%02d", h, m, s)
    }
}
