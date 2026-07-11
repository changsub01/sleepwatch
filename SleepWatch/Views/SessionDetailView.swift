import SwiftUI

struct SessionDetailView: View {
    let session: SleepSession

    /// Timeline is chunked into fixed windows; windows with no detected
    /// sound are still shown, just with no content underneath.
    private let bucketSize: TimeInterval = 30 * 60

    var body: some View {
        List {
            Section {
                LabeledContent("시작", value: SleepFormat.dayTime.string(from: session.startTime))
                LabeledContent("종료", value: session.endTime.map { SleepFormat.dayTime.string(from: $0) } ?? "-")
                LabeledContent("지속 시간", value: SleepFormat.duration(session.duration))
                LabeledContent("감지된 이벤트", value: "\(session.events.count)건")
            }

            Section("타임라인") {
                ForEach(buckets, id: \.start) { bucket in
                    VStack(alignment: .leading, spacing: 6) {
                        Text("\(SleepFormat.clock.string(from: bucket.start).prefix(5)) ~ \(SleepFormat.clock.string(from: bucket.end).prefix(5))")
                            .font(.subheadline.bold())

                        if bucket.events.isEmpty {
                            Text("기록 없음")
                                .font(.footnote)
                                .foregroundStyle(.tertiary)
                        } else {
                            ForEach(bucket.events) { event in
                                Text(SleepFormat.clock.string(from: event.timestamp))
                                    .font(.footnote.monospaced())
                                    .foregroundStyle(.secondary)
                            }
                        }
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle(SleepFormat.dayTime.string(from: session.startTime))
    }

    private struct Bucket {
        let start: Date
        let end: Date
        let events: [SleepEvent]
    }

    private var buckets: [Bucket] {
        let end = session.endTime ?? Date()
        guard session.startTime < end else { return [] }

        let sortedEvents = session.events.sorted { $0.timestamp < $1.timestamp }
        var result: [Bucket] = []
        var cursor = session.startTime

        while cursor < end {
            let bucketEnd = min(cursor.addingTimeInterval(bucketSize), end)
            let eventsInBucket = sortedEvents.filter { $0.timestamp >= cursor && $0.timestamp < bucketEnd }
            result.append(Bucket(start: cursor, end: bucketEnd, events: eventsInBucket))
            cursor = bucketEnd
        }
        return result
    }
}
