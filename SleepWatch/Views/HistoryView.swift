import SwiftUI
import SwiftData

struct HistoryView: View {
    @Environment(\.dismiss) private var dismiss
    @Query(sort: \SleepSession.startTime, order: .reverse) private var sessions: [SleepSession]

    var body: some View {
        List {
            if sessions.isEmpty {
                Text("아직 기록이 없습니다")
                    .foregroundStyle(.secondary)
            }
            ForEach(sessions.filter { !$0.isActive }) { session in
                NavigationLink(value: session) {
                    row(for: session)
                }
            }
        }
        .navigationTitle("수면 기록")
        .navigationDestination(for: SleepSession.self) { session in
            SessionDetailView(session: session)
        }
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button("닫기") { dismiss() }
            }
        }
    }

    private func row(for session: SleepSession) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(SleepFormat.dayTime.string(from: session.startTime))
                .font(.headline)
            HStack {
                if let end = session.endTime {
                    Text("~ \(SleepFormat.dayTime.string(from: end))")
                }
                Spacer()
                Text(SleepFormat.duration(session.duration))
                    .monospaced()
                Text("· 이벤트 \(session.events.count)건")
                    .foregroundStyle(.secondary)
            }
            .font(.subheadline)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}
