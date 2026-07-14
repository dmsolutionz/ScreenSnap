// Decodes the primary audio track into min/max peaks per time bucket, for waveform rendering in the
// timeline. Reuses the exact decode path pipeline.js already uses for export (AudioBufferSink from
// Mediabunny) rather than introducing a second audio-decode mechanism like AudioContext.decodeAudioData.
import { AudioBufferSink } from "../vendor/mediabunny.mjs";

// { input, durationSec, buckets } -> { peaks: Float32Array(buckets*2) [min0,max0,min1,max1,...], buckets }
// or null when the clip has no audio track (common for screen recordings without mic/tab-audio capture).
// Samples are strided rather than read in full — only ~24 samples/bucket are needed for a waveform
// silhouette, so a long recording still decodes in a reasonable time.
export async function computeWaveformPeaks({ input, durationSec, buckets = 600 }) {
  const track = await input.getPrimaryAudioTrack();
  if (!track || !(durationSec > 0)) return null;

  const peaks = new Float32Array(buckets * 2);
  for (let i = 0; i < buckets; i++) { peaks[i * 2] = 0; peaks[i * 2 + 1] = 0; }

  const sink = new AudioBufferSink(track);
  let stride = 0; // samples to skip between reads; set once the first buffer reveals the sample rate
  let sawSample = false;
  for await (const { buffer, timestamp } of sink.buffers(0, durationSec)) {
    if (!buffer || !buffer.length) continue;
    if (!stride) {
      const estTotal = Math.max(1, buffer.sampleRate * durationSec);
      stride = Math.max(1, Math.floor(estTotal / (buckets * 24))); // ~24 samples/bucket over the whole clip
    }
    const data = buffer.getChannelData(0);
    const invSampleRate = 1 / buffer.sampleRate;
    for (let i = 0; i < data.length; i += stride) {
      const t = timestamp + i * invSampleRate;
      let bi = Math.floor((t / durationSec) * buckets);
      if (bi < 0) bi = 0; else if (bi >= buckets) bi = buckets - 1;
      const v = data[i];
      if (v < peaks[bi * 2]) peaks[bi * 2] = v;
      if (v > peaks[bi * 2 + 1]) peaks[bi * 2 + 1] = v;
      sawSample = true;
    }
  }
  if (!sawSample) return null;
  return { peaks, buckets };
}
