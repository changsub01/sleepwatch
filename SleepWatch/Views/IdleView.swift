import SwiftUI

struct IdleView: View {
    @EnvironmentObject private var sessionManager: SessionManager
    @AppStorage(SleepSettings.autoStopHoursKey) private var autoStopHours: Double = SleepSettings.defaultAutoStopHours

    @State private var showHistory = false

    var body: some View {
        VStack(spacing: 32) {
            Spacer()

            Text("SleepWatch")
                .font(.largeTitle.bold())

            VStack(spacing: 8) {
                Text(autoStopHours == 0 ? "자동 종료 없음 (수동 종료만)" : "\(autoStopHours, specifier: "%.0f")시간 후 자동 종료")
                    .foregroundStyle(.secondary)
                Stepper(value: $autoStopHours, in: 0...12, step: 1) {
                    EmptyView()
                }
                .labelsHidden()
                .frame(width: 160)
            }

            Button {
                sessionManager.start(autoStopAfter: autoStopHours * 3600)
            } label: {
                Text("시작")
                    .font(.title.bold())
                    .frame(width: 220, height: 220)
                    .background(Circle().fill(Color.accentColor))
                    .foregroundStyle(.white)
            }
            .buttonStyle(.plain)

            Spacer()

            Button("기록 보기") { showHistory = true }
                .padding(.bottom, 24)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(.black)
        .foregroundStyle(.white)
        .alert("마이크 권한이 필요합니다", isPresented: $sessionManager.permissionDenied) {
            Button("확인", role: .cancel) {}
        } message: {
            Text("설정 > 개인정보 보호 > 마이크에서 SleepWatch 권한을 허용해주세요.")
        }
        .sheet(isPresented: $showHistory) {
            NavigationStack { HistoryView() }
        }
    }
}
