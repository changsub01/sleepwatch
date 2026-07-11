import SwiftUI

struct MonitoringView: View {
    @EnvironmentObject private var sessionManager: SessionManager
    @State private var showStopConfirm = false

    var body: some View {
        VStack(spacing: 40) {
            Spacer()

            // 주 콘텐츠: 현재 시각
            Text(SleepFormat.clock.string(from: sessionManager.currentTime))
                .font(.system(size: 140, weight: .bold, design: .monospaced))
                .minimumScaleFactor(0.5)
                .lineLimit(1)

            HStack(spacing: 60) {
                VStack(spacing: 8) {
                    Text("시작 시간")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text(SleepFormat.clock.string(from: sessionManager.currentSession?.startTime ?? Date()))
                        .font(.system(size: 44, weight: .semibold, design: .monospaced))
                }
                VStack(spacing: 8) {
                    Text("지속 시간")
                        .font(.title3)
                        .foregroundStyle(.secondary)
                    Text(SleepFormat.duration(sessionManager.elapsed))
                        .font(.system(size: 44, weight: .semibold, design: .monospaced))
                }
            }

            if let count = sessionManager.currentSession?.events.count {
                Text("감지된 이벤트: \(count)건")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }

            Spacer()

            Button(role: .destructive) {
                showStopConfirm = true
            } label: {
                Text("종료")
                    .font(.title2.bold())
                    .frame(width: 160, height: 60)
            }
            .buttonStyle(.borderedProminent)
            .tint(.red)
            .padding(.bottom, 40)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .foregroundStyle(.white)
        .confirmationDialog("수면 기록을 종료할까요?", isPresented: $showStopConfirm, titleVisibility: .visible) {
            Button("종료", role: .destructive) { sessionManager.stop() }
            Button("취소", role: .cancel) {}
        }
        .statusBarHidden()
    }
}
