import Foundation
import CoreAudio
import AudioToolbox
import Accelerate

/// One reduced analysis frame. Raw PCM never leaves this process.
struct SpectrumFrame: Encodable {
    let capturedAt: Double
    let bands: [Double]
    let rms: Double
    let onset: Double
}

/// Turns the interleaved float stream delivered by the Core Audio process tap
/// into a 12-band logarithmic spectrum (45 Hz – 16 kHz) at a steady frame rate.
///
/// Adapted from dsh-bgm (MIT, © skymecode) — the tap plumbing is reused as-is;
/// the analysis is replaced by a real FFT so every band moves on its own.
final class SpectrumAnalyzer: @unchecked Sendable {
    static let bandCount = 12
    static let fftSize = 2048
    static let hopSize = 1024
    static let lowHz = 45.0
    static let highHz = 16_000.0
    /// Frames to skip while the per-band reference level settles (~1 s at 33 ms).
    static let warmupFrames = 30

    private let lock = NSLock()
    private let sampleRate: Double
    private let log2n: vDSP_Length
    private let fftSetup: FFTSetup
    private let window: [Float]

    private var pending: [Float] = []
    private var lowBins: [Int] = []
    private var highBins: [Int] = []
    private var runningMean: [Double]
    private var bandValues: [Double]
    private var rmsSum: Double = 0
    private var rmsCount: Int = 0
    private var envelope: Double = 0
    private var onset: Double = 0
    private var rms: Double = 0
    private var framesAnalyzed = 0

    init(sampleRate: Double) {
        self.sampleRate = sampleRate > 0 ? sampleRate : 48_000
        self.log2n = vDSP_Length(log2(Double(Self.fftSize)))
        guard let setup = vDSP_create_fftsetup(log2n, FFTRadix(kFFTRadix2)) else {
            fatalError("vDSP_create_fftsetup failed")
        }
        self.fftSetup = setup

        var win = [Float](repeating: 0, count: Self.fftSize)
        vDSP_hann_window(&win, vDSP_Length(Self.fftSize), Int32(vDSP_HANN_NORM))
        self.window = win

        self.runningMean = Array(repeating: 1e-4, count: Self.bandCount)
        self.bandValues = Array(repeating: 0, count: Self.bandCount)

        let nyquistBin = Self.fftSize / 2 - 1
        let binWidth = self.sampleRate / Double(Self.fftSize)
        let ratio = pow(Self.highHz / Self.lowHz, 1.0 / Double(Self.bandCount))
        var edges: [Double] = []
        for index in 0...Self.bandCount {
            edges.append(Self.lowHz * pow(ratio, Double(index)))
        }
        for band in 0..<Self.bandCount {
            let low = max(1, Int(edges[band] / binWidth))
            let high = max(low, Int(edges[band + 1] / binWidth))
            lowBins.append(min(low, nyquistBin))
            highBins.append(min(high, nyquistBin))
        }

        pending.reserveCapacity(Self.fftSize * 4)
    }

    deinit {
        vDSP_destroy_fftsetup(fftSetup)
    }

    func consume(_ input: UnsafePointer<AudioBufferList>, format: AudioStreamBasicDescription) {
        guard format.mFormatID == kAudioFormatLinearPCM else { return }
        let isFloat = (format.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let bits = Int(format.mBitsPerChannel)
        let list = UnsafeMutableAudioBufferListPointer(UnsafeMutablePointer(mutating: input))

        var chunk: [Float] = []
        chunk.reserveCapacity(4096)

        for buffer in list {
            guard let data = buffer.mData else { continue }
            let bytes = Int(buffer.mDataByteSize)
            if isFloat && bits == 32 {
                let count = bytes / MemoryLayout<Float>.size
                let values = data.bindMemory(to: Float.self, capacity: count)
                for index in 0..<count { chunk.append(values[index]) }
            } else if !isFloat && bits == 16 {
                let count = bytes / MemoryLayout<Int16>.size
                let values = data.bindMemory(to: Int16.self, capacity: count)
                for index in 0..<count { chunk.append(Float(values[index]) / Float(Int16.max)) }
            } else if !isFloat && bits == 32 {
                let count = bytes / MemoryLayout<Int32>.size
                let values = data.bindMemory(to: Int32.self, capacity: count)
                for index in 0..<count { chunk.append(Float(values[index]) / Float(Int32.max)) }
            }
        }
        guard !chunk.isEmpty else { return }
        ingest(chunk)
    }

    private func ingest(_ chunk: [Float]) {
        lock.lock()
        defer { lock.unlock() }

        for sample in chunk {
            let value = sample.isFinite ? max(-1, min(1, sample)) : 0
            pending.append(value)
            rmsSum += Double(value * value)
            rmsCount += 1
        }

        while pending.count >= Self.fftSize {
            computeSpectrumLocked()
            pending.removeFirst(Self.hopSize)
        }
    }

    private func computeSpectrumLocked() {
        var windowed = [Float](repeating: 0, count: Self.fftSize)
        pending.withUnsafeBufferPointer { source in
            guard let base = source.baseAddress else { return }
            vDSP_vmul(base, 1, window, 1, &windowed, 1, vDSP_Length(Self.fftSize))
        }

        let half = Self.fftSize / 2
        var real = [Float](repeating: 0, count: half)
        var imag = [Float](repeating: 0, count: half)
        var magnitudes = [Float](repeating: 0, count: half)

        real.withUnsafeMutableBufferPointer { realBuffer in
            imag.withUnsafeMutableBufferPointer { imagBuffer in
                magnitudes.withUnsafeMutableBufferPointer { magnitudeBuffer in
                    var split = DSPSplitComplex(
                        realp: realBuffer.baseAddress!,
                        imagp: imagBuffer.baseAddress!
                    )
                    windowed.withUnsafeBufferPointer { source in
                        guard let base = source.baseAddress else { return }
                        base.withMemoryRebound(to: DSPComplex.self, capacity: half) { pointer in
                            vDSP_ctoz(pointer, 2, &split, 1, vDSP_Length(half))
                        }
                    }
                    vDSP_fft_zrip(fftSetup, &split, 1, log2n, FFTDirection(FFT_FORWARD))
                    vDSP_zvabs(&split, 1, magnitudeBuffer.baseAddress!, 1, vDSP_Length(half))
                }
            }
        }

        let scale = Float(1.0 / Double(Self.fftSize))
        framesAnalyzed += 1
        for band in 0..<Self.bandCount {
            let low = lowBins[band]
            let high = highBins[band]
            var sum: Float = 0
            for bin in low...max(low, high) {
                let value = magnitudes[bin] * scale
                sum += value * value
            }
            let power = Double((sum / Float(max(1, high - low + 1))).squareRoot())

            if runningMean[band] <= 0 {
                // First sighting: adopt this level as the reference, emit silence.
                runningMean[band] = max(power, 1e-9)
                bandValues[band] = 0
            } else if framesAnalyzed <= Self.warmupFrames {
                // Converge the reference before trusting any relative reading.
                runningMean[band] = runningMean[band] * 0.85 + power * 0.15
                bandValues[band] = 0
            } else {
                let mean = runningMean[band]
                let db = 20 * log10(max(power, 1e-9) / mean)
                // -9 dB .. +17 dB maps onto 0 .. 1; transients spike, sustained content sits mid-way.
                bandValues[band] = min(1, max(0, (db + 9) / 26))
                runningMean[band] = mean * 0.995 + power * 0.005
            }
        }
    }

    /// Called by the frame timer; returns the latest state and advances the envelope.
    func takeFrame() -> SpectrumFrame {
        lock.lock()
        let count = max(1, rmsCount)
        let rawRms = (rmsSum / Double(count)).squareRoot()
        rmsSum = 0
        rmsCount = 0
        let bands = bandValues
        lock.unlock()

        rms = rawRms
        envelope = envelope * 0.88 + rawRms * 0.12
        let rawOnset = max(0, rawRms - envelope)
        onset = min(1, rawOnset * 36)

        return SpectrumFrame(
            capturedAt: Date().timeIntervalSince1970 * 1_000,
            bands: bands,
            rms: compressed(rawRms, gain: 11),
            onset: onset
        )
    }

    private func compressed(_ value: Double, gain: Double) -> Double {
        min(1, max(0, 1 - exp(-value * gain)))
    }
}
