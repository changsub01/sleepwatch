# SleepWatch

아이패드에서 침대 옆에 두고 쓰는 수면 기록 앱입니다. 시작 버튼을 누르면 마이크로 소리(코골이, 뒤척임 등)를 감지해 기록하고, 화면에는 현재 시각·시작 시간·지속 시간을 크게 보여줍니다.

이 저장소에는 두 가지 구현이 있습니다.

- **`web/`** — Safari에서 바로 실행되는 웹 앱(PWA). **Mac이나 Apple Developer 계정 없이** 지금 바로 쓸 수 있습니다. (권장)
- **`SleepWatch/`** — SwiftUI 네이티브 앱 소스. Mac + Xcode가 있을 때 사용하세요 (`Docs/XCODE_SETUP.md` 참고).

## 웹 앱 사용법 (Mac 불필요)

### 1. GitHub Pages 켜기 (최초 1회, 저장소 소유자만)

1. GitHub 저장소 → **Settings > Pages**
2. **Build and deployment > Source**를 **GitHub Actions**로 선택
3. `.github/workflows/deploy-pages.yml`이 `web/` 폴더를 자동으로 배포합니다. 이 브랜치에 푸시하면 Actions 탭에서 배포 진행 상황을 볼 수 있고, 완료되면 Settings > Pages에 공개 URL(`https://<사용자명>.github.io/sleepwatch/`)이 표시됩니다.

### 2. 아이패드에서 열기

1. 아이패드 **Safari**에서 위 GitHub Pages 주소로 접속 (반드시 `https://` 주소여야 마이크 권한이 동작합니다)
2. 공유 버튼 → **홈 화면에 추가** → 이제 홈 화면 아이콘으로 앱처럼 실행 가능
3. 처음 "시작"을 누르면 마이크 권한 팝업이 뜨는데 **허용**을 눌러야 합니다

### 3. 사용 중 주의할 점

- 소리 감지는 **화면이 켜져 있고 이 페이지가 앞에 떠 있을 때만** 동작합니다 (화면을 끄거나 다른 앱으로 전환하면 감지가 멈춤). 애초에 시계를 계속 화면에 띄워두는 용도라 자연스럽게 맞는 사용 방식입니다.
- 밤새 화면을 켜두므로 아이패드를 **충전 중** 상태로 사용하는 걸 권장합니다.
- 기록은 아이패드의 Safari 로컬 저장소에 저장됩니다. Safari 데이터(웹사이트 데이터)를 지우면 기록도 함께 삭제되니 주의하세요.

### 4. 로컬에서 미리 확인하고 싶다면

```bash
cd web
python3 -m http.server 8000
```

이후 `http://localhost:8000`으로 접속하면 됩니다 (localhost는 HTTPS가 아니어도 마이크 권한이 동작합니다).

## 네이티브 앱 (SwiftUI)

Mac + Xcode가 있다면 `SleepWatch/` 폴더의 Swift 소스로 네이티브 앱을 빌드할 수 있습니다. 설정 방법은 `Docs/XCODE_SETUP.md`를 참고하세요.
