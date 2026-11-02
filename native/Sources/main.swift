import Foundation
import CoreAudio
import Darwin

// dsh-audio-rail-macos — native system-audio capture helper.
//
// Emits newline-delimited JSON on stdout:
//   {"type":"ready","platform":"darwin","sampleRate":48000,"channels":2,"bands":12}
//   {"type":"frame","frame":{"capturedAt":…,"bands":[…12…],"rms":…,"onset":…}}
//   {"type":"permission","granted":false,"reason":"…"}
//   {"type":"error","code":"…","message":"…"}
//
// Lifecycle rules that matter for shipping:
//   * stdin EOF means the host died — exit instead of lingering as an orphan
//     that keeps the system-audio tap (and its recording indicator) alive.
//   * the default output device can change under us (headphones, Bluetooth);
//     the tap is rebuilt so we keep hearing whatever is actually playing.
//
// Audio plumbing adapted from dsh-bgm (MIT, © skymecode).

private struct ReadyEvent: Encodable {
    let type = "ready"
    let platform = "darwin"
    let sampleRate: Double
    let channels: UInt32
    let bands: Int
}

private struct FrameEvent: Encodable {
    let type = "frame"
    let frame: SpectrumFrame
}

private struct PermissionEvent: Encodable {
    let type = "permission"
    let granted: Bool
    let reason: String?
}

private struct ErrorEvent: Encodable {
    let type = "error"
    let code: String
    let message: String
}

private final class Output: @unchecked Sendable {
    private let queue = DispatchQueue(label: "com.dsh.audiorail.output")
    private let encoder = JSONEncoder()

    func send<T: Encodable>(_ value: T) {
        queue.sync {
            guard let data = try? encoder.encode(value) else { return }
            FileHandle.standardOutput.write(data)
            FileHandle.standardOutput.write(Data([0x0a]))
        }
    }
}

/// Owns the tap + analyzer pair so it can be rebuilt when the output device
/// changes, without tearing down the frame timer.
private final class AudioPipeline: @unchecked Sendable {
    private let lock = NSLock()
    private let queue = DispatchQueue(label: "com.dsh.audiorail.pipeline")
    private var tap: SystemAudioTap?
    private var analyzer: SpectrumAnalyzer?
    private var deviceListener: AudioObjectPropertyListenerBlock?

    func start() throws -> SystemAudioTap {
        let created = SystemAudioTap()
        let createdAnalyzer = try created.start { SpectrumAnalyzer(sampleRate: $0) }
        lock.lock()
        tap = created
        analyzer = createdAnalyzer
        lock.unlock()
        return created
    }

    func takeFrame() -> SpectrumFrame? {
        lock.lock()
        let current = analyzer
        lock.unlock()
        return current?.takeFrame()
    }

    /// Rebuilds the tap after the default output device changed. A failure keeps
    /// the previous pipeline instead of killing a helper that is merely
    /// re-routing: silence beats a crash loop on a hot-plug.
    func rebuild(afterChange: @escaping (String) -> Void) {
        queue.async { [weak self] in
            guard let self else { return }
            self.lock.lock()
            let previous = self.tap
            self.lock.unlock()

            do {
                let replacement = SystemAudioTap()
                let replacementAnalyzer = try replacement.start { SpectrumAnalyzer(sampleRate: $0) }
                self.lock.lock()
                self.tap = replacement
                self.analyzer = replacementAnalyzer
                self.lock.unlock()
                previous?.stop()
            } catch {
                afterChange(error.localizedDescription)
            }
        }
    }

    func stop() {
        lock.lock()
        let current = tap
        tap = nil
        analyzer = nil
        lock.unlock()
        current?.stop()
    }

    func installDeviceListener(onChange: @escaping () -> Void) {
        var address = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultOutputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        let block: AudioObjectPropertyListenerBlock = { _, _ in onChange() }
        let status = AudioObjectAddPropertyListenerBlock(
            AudioObjectID.system,
            &address,
            queue,
            block
        )
        if status == noErr {
            deviceListener = block
        } else {
            FileHandle.standardError.write(
                Data("default-output listener unavailable: \(status.fourCC)\n".utf8)
            )
        }
    }
}

@main
struct DshAudioRailTap {
    private static let output = Output()
    private static let pipeline = AudioPipeline()
    private static var frameTimer: DispatchSourceTimer?
    private static var signalSources: [DispatchSourceSignal] = []

    static func main() {
        do {
            let tap = try pipeline.start()
            pipeline.installDeviceListener {
                pipeline.rebuild(afterChange: { message in
                    FileHandle.standardError.write(
                        Data("device-change rebuild failed: \(message)\n".utf8)
                    )
                })
            }
            output.send(ReadyEvent(
                sampleRate: tap.format.mSampleRate,
                channels: tap.format.mChannelsPerFrame,
                bands: SpectrumAnalyzer.bandCount
            ))

            let timer = DispatchSource.makeTimerSource(queue: DispatchQueue(label: "com.dsh.audiorail.frames"))
            timer.schedule(deadline: .now(), repeating: .milliseconds(33), leeway: .milliseconds(4))
            timer.setEventHandler {
                guard let frame = pipeline.takeFrame() else { return }
                output.send(FrameEvent(frame: frame))
            }
            timer.resume()
            frameTimer = timer
            watchStdinForEOF()
            installSignalHandlers()
            dispatchMain()
        } catch {
            // Terminal, not transient: the host must not restart us in a loop
            // while the user has not granted system-audio recording yet.
            output.send(PermissionEvent(granted: false, reason: error.localizedDescription))
            FileHandle.standardError.write(
                Data("system audio tap unavailable: \(error.localizedDescription)\n".utf8)
            )
            exit(2)
        }
    }

    /// The host owns our stdin. EOF means it is gone — do not outlive it while
    /// holding a system-audio tap (and its recording indicator).
    private static func watchStdinForEOF() {
        Thread.detachNewThread {
            while readLine(strippingNewline: true) != nil {}
            shutdown(reason: "stdin closed")
        }
    }

    private static func installSignalHandlers() {
        for code in [SIGINT, SIGTERM] {
            signal(code, SIG_IGN)
            let source = DispatchSource.makeSignalSource(signal: code, queue: .main)
            source.setEventHandler { shutdown(reason: "signal \(code)") }
            source.resume()
            signalSources.append(source)
        }
    }

    private static func shutdown(reason: String) {
        frameTimer?.cancel()
        frameTimer = nil
        pipeline.stop()
        FileHandle.standardError.write(Data("shutting down: \(reason)\n".utf8))
        exit(0)
    }
}
