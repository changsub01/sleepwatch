import AVFoundation
import Foundation

/// Monitors microphone input level in real time and reports discrete sound
/// events (e.g. snoring, movement noise) without ever writing raw audio to
/// disk — only timestamp + peak level are surfaced.
final class SoundDetector {
    /// dBFS threshold above which a sample is considered a "sound event".
    /// Typical quiet room ambience sits around -50 dB or lower.
    var thresholdDecibels: Float = -30

    /// Minimum gap between two reported events, so a sustained noise
    /// (e.g. a cough) is reported once instead of many times per second.
    var debounceInterval: TimeInterval = 5

    var onEvent: ((Date, Float) -> Void)?

    private let engine = AVAudioEngine()
    private var lastEventTime: Date?
    private(set) var isRunning = false

    func requestPermission(completion: @escaping (Bool) -> Void) {
        if #available(iOS 17.0, *) {
            AVAudioApplication.requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        } else {
            AVAudioSession.sharedInstance().requestRecordPermission { granted in
                DispatchQueue.main.async { completion(granted) }
            }
        }
    }

    func start() throws {
        guard !isRunning else { return }

        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .measurement, options: [.mixWithOthers])
        try session.setActive(true)

        let input = engine.inputNode
        let format = input.inputFormat(forBus: 0)

        input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            self?.process(buffer: buffer)
        }

        engine.prepare()
        try engine.start()
        isRunning = true
    }

    func stop() {
        guard isRunning else { return }
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
        isRunning = false
        lastEventTime = nil
    }

    private func process(buffer: AVAudioPCMBuffer, at time: Date = Date()) {
        guard let channelData = buffer.floatChannelData?[0] else { return }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return }

        var sumOfSquares: Float = 0
        for i in 0..<frameCount {
            let sample = channelData[i]
            sumOfSquares += sample * sample
        }
        let rms = sqrt(sumOfSquares / Float(frameCount))
        let decibels = 20 * log10(max(rms, 1e-7))

        guard decibels > thresholdDecibels else { return }

        if let last = lastEventTime, time.timeIntervalSince(last) < debounceInterval {
            return
        }
        lastEventTime = time

        DispatchQueue.main.async { [weak self] in
            self?.onEvent?(time, decibels)
        }
    }
}
