// Synthetic microphone sink. Overrides navigator.mediaDevices.getUserMedia so the SDK
// connects to a MediaStream backed by a Web Audio MediaStreamDestination we control.
// Voice In rows: SchedulerCalls play(buffer) which schedules the AudioBuffer to play
// through the destination in real time; SDK's VAD/STT see this as user speech.

export class MicSink {
  private ctx: AudioContext;
  private destination: MediaStreamAudioDestinationNode;
  private silence: AudioBufferSourceNode | null = null;

  constructor() {
    this.ctx = new AudioContext({ sampleRate: 48000 });
    this.destination = this.ctx.createMediaStreamDestination();
    this.startSilence();
  }

  // Continuously emit silence so the MediaStreamTrack is "live" between utterances.
  private startSilence(): void {
    const buf = this.ctx.createBuffer(1, this.ctx.sampleRate, this.ctx.sampleRate);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    src.loop = true;
    src.connect(this.destination);
    src.start();
    this.silence = src;
  }

  get mediaStream(): MediaStream {
    return this.destination.stream;
  }

  installGetUserMediaOverride(): void {
    const mediaDevices = (navigator as any).mediaDevices ?? ((navigator as any).mediaDevices = {});
    const fakeStream = this.mediaStream;
    mediaDevices.getUserMedia = async () => fakeStream;
    mediaDevices.enumerateDevices = async () => [
      {
        deviceId: "convai-evals-fake-mic",
        kind: "audioinput",
        label: "Convai Evals Fake Mic",
        groupId: "convai-evals",
        toJSON() {
          return this;
        },
      } as unknown as MediaDeviceInfo,
    ];
  }

  /**
   * Schedule a decoded AudioBuffer to play out the synthetic mic in real-time.
   * Returns when the audio has finished playing (allows caller to mark t_input_end).
   */
  async play(buffer: AudioBuffer): Promise<void> {
    await this.ctx.resume();
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(this.destination);
    return new Promise((resolve) => {
      src.onended = () => {
        try {
          src.disconnect();
        } catch {
          // ignore
        }
        resolve();
      };
      src.start();
    });
  }

  async decodeWavFromUrl(url: string): Promise<AudioBuffer> {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`failed to fetch WAV ${url}: ${resp.status}`);
    const ab = await resp.arrayBuffer();
    return this.ctx.decodeAudioData(ab.slice(0));
  }
}
