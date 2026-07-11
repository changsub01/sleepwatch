# Xcode 프로젝트 설정 가이드

이 저장소에는 SleepWatch 앱의 Swift 소스 코드만 들어 있습니다 (`.xcodeproj`는 없습니다).
Mac에서 Xcode로 프로젝트를 만들고 이 파일들을 추가해야 빌드/실행할 수 있습니다.

## 1. 새 프로젝트 만들기

1. Xcode 실행 → **File > New > Project**
2. **iOS > App** 선택 (iPadOS 전용으로 설정은 아래에서 별도 진행)
3. 옵션:
   - Product Name: `SleepWatch`
   - Interface: **SwiftUI**
   - Language: **Swift**
   - Storage: **SwiftData** 체크
4. 저장 위치는 이 저장소의 최상위 폴더(`sleepwatch/`)로 지정

## 2. iPad 전용으로 설정

1. 프로젝트 네비게이터에서 프로젝트 파일 선택 → TARGETS > SleepWatch > **General**
2. **Supported Destinations**에서 iPhone 제거, iPad만 남기기
   (또는 Build Settings에서 `TARGETED_DEVICE_FAMILY = 2`)

## 3. 소스 파일 교체

Xcode가 자동 생성한 `SleepWatchApp.swift`, `ContentView.swift`, `Item.swift` 등을 삭제하고,
이 저장소의 `SleepWatch/` 폴더 전체를 Xcode 프로젝트로 드래그 앤 드롭하여 추가하세요.
("Copy items if needed" 체크 해제 — 이미 올바른 위치에 있으므로 참조만 추가)

추가되어야 할 파일:
```
SleepWatch/SleepWatchApp.swift
SleepWatch/Models/SleepSession.swift
SleepWatch/Models/SleepEvent.swift
SleepWatch/Managers/SoundDetector.swift
SleepWatch/Managers/SessionManager.swift
SleepWatch/Views/RootView.swift
SleepWatch/Views/IdleView.swift
SleepWatch/Views/MonitoringView.swift
SleepWatch/Views/HistoryView.swift
SleepWatch/Views/SessionDetailView.swift
SleepWatch/Views/Formatting.swift
SleepWatch/Settings/SleepSettings.swift
```

## 4. Info.plist 설정

TARGETS > SleepWatch > **Info** 탭에서 다음 키를 추가하세요:

| Key | Value |
|---|---|
| Privacy - Microphone Usage Description (`NSMicrophoneUsageDescription`) | 수면 중 소리를 감지해 기록하기 위해 마이크 접근이 필요합니다 |

## 5. Background Modes 켜기

TARGETS > SleepWatch > **Signing & Capabilities** → **+ Capability** → **Background Modes** 추가 →
**Audio, AirPlay, and Picture in Picture** 체크.
(화면이 꺼지거나 잠겨도 마이크 감지가 계속되도록 하기 위함입니다.)

## 6. 빌드 & 실행

1. 시뮬레이터로 먼저 빌드해서 화면 흐름(시작 → 모니터링 → 종료 → 기록)이 정상 동작하는지 확인
   - 시뮬레이터는 실제 마이크 입력을 받지 않으므로 소리 이벤트 감지는 확인 어려움
2. 실제 아이패드에 연결해서 실행 (Xcode에서 기기 선택 후 Run)
   - 최초 실행 시 마이크 권한 요청 팝업 → 허용
   - 마이크 근처에서 소리를 내어 이벤트가 기록되는지 확인
   - "종료" 버튼으로 수동 종료 후 "기록 보기"에서 방금 세션이 보이는지 확인
   - 자동 종료 테스트: 시작 화면에서 자동 종료 시간을 최소값으로 낮추고 몇 분 뒤 자동 종료되는지 확인
   - 화면을 잠그거나 앱을 백그라운드로 보낸 상태에서도 이벤트가 계속 기록되는지 확인 (충전 중 테스트 권장 — 마이크를 계속 켜두면 배터리 소모가 큽니다)

## 참고: 배포 타깃

SwiftData를 사용하므로 **iOS/iPadOS 17.0 이상**을 배포 타깃으로 설정하세요.
(TARGETS > SleepWatch > General > Minimum Deployments)
