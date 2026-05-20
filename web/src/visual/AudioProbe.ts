import type { AudioProbeDebug } from "./visualTypes.js";

type AudioLogHandler = (name: string, data?: Record<string, unknown>) => void;

export class AudioProbe {
  private audioContext: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private scratch: Uint8Array<ArrayBuffer> | null = null;
  private audioElements = new Map<string, HTMLAudioElement>();
  private livekitTracks = new Map<string, { detach?: (el: HTMLMediaElement) => void }>();
  private mediaSource: MediaStreamAudioSourceNode | MediaElementAudioSourceNode | null = null;
  private outputGain: GainNode | null = null;
  private room: any = null;
  private boundSubscribed = this.handleTrackSubscribed.bind(this);
  private boundUnsubscribed = this.handleTrackUnsubscribed.bind(this);
  private level = 0;
  private maxLevel = 0;
  private muted = false;
  private scanCount = 0;
  private lastAttachError: string | undefined;
  private lastPlayError: string | undefined;
  private onLog: AudioLogHandler | null = null;

  setLogHandler(handler: AudioLogHandler | null): void {
    this.onLog = handler;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    for (const el of this.audioElements.values()) {
      el.muted = muted;
    }
    if (this.outputGain) this.outputGain.gain.value = muted ? 0 : 1;
    this.onLog?.("audio_mute_changed", { muted });
  }

  attachRoom(room: any): void {
    this.detach();
    this.room = room;
    room?.on?.("trackSubscribed", this.boundSubscribed);
    room?.on?.("trackUnsubscribed", this.boundUnsubscribed);
    this.onLog?.("audio_room_attached", { hasRoom: Boolean(room) });
    this.scanExistingTracks();
  }

  async resume(): Promise<void> {
    if (!this.audioContext) return;
    if (this.audioContext.state === "suspended") await this.audioContext.resume();
    this.onLog?.("audio_context_resume", { state: this.audioContext.state });
  }

  getLevel(): number {
    if (!this.analyser || !this.scratch) return this.level;
    this.analyser.getByteTimeDomainData(this.scratch);
    let sum = 0;
    for (const v of this.scratch) {
      const centered = (v - 128) / 128;
      sum += centered * centered;
    }
    this.level = Math.sqrt(sum / this.scratch.length);
    this.maxLevel = Math.max(this.maxLevel, this.level);
    return this.level;
  }

  getDebug(): AudioProbeDebug {
    return {
      attachedTracks: this.livekitTracks.size,
      attachedElements: this.audioElements.size,
      analyserReady: Boolean(this.analyser),
      audioContextState: this.audioContext?.state ?? "none",
      lastAttachError: this.lastAttachError,
      lastPlayError: this.lastPlayError,
      lastLevel: this.level,
      maxLevel: this.maxLevel,
      scanCount: this.scanCount,
      muted: this.muted,
    };
  }

  scanExistingTracks(): void {
    this.scanCount += 1;
    let publicationsSeen = 0;
    this.room?.remoteParticipants?.forEach?.((participant: any) => {
      participant.audioTrackPublications?.forEach?.((publication: any) => {
        publicationsSeen += 1;
        if (publication.track) this.attachAudioTrack(publication);
      });
    });
    this.onLog?.("audio_track_scan", {
      scanCount: this.scanCount,
      publicationsSeen,
      attachedTracks: this.livekitTracks.size,
      analyserReady: Boolean(this.analyser),
    });
  }

  detach(): void {
    this.room?.off?.("trackSubscribed", this.boundSubscribed);
    this.room?.off?.("trackUnsubscribed", this.boundUnsubscribed);
    for (const [sid, el] of this.audioElements) {
      const track = this.livekitTracks.get(sid);
      track?.detach?.(el);
      el.pause();
      el.srcObject = null;
      el.remove();
    }
    this.audioElements.clear();
    this.livekitTracks.clear();
    this.analyser = null;
    this.scratch = null;
    this.mediaSource?.disconnect();
    this.mediaSource = null;
    this.outputGain?.disconnect();
    this.outputGain = null;
    this.audioContext?.close().catch(() => undefined);
    this.audioContext = null;
    this.room = null;
    this.level = 0;
    this.maxLevel = 0;
  }

  private handleTrackSubscribed(track: any, publication: any): void {
    this.onLog?.("audio_track_subscribed", {
      trackKind: track?.kind,
      trackSid: publication?.trackSid ?? publication?.sid,
      hasTrack: Boolean(publication?.track),
    });
    if (track?.kind === "audio" || publication?.track?.kind === "audio") {
      this.attachAudioTrack(publication);
    }
  }

  private handleTrackUnsubscribed(_track: any, publication: any): void {
    const sid = publication?.trackSid;
    if (!sid) return;
    const el = this.audioElements.get(sid);
    if (!el) return;
    this.livekitTracks.get(sid)?.detach?.(el);
    el.remove();
    this.audioElements.delete(sid);
    this.livekitTracks.delete(sid);
  }

  private attachAudioTrack(publication: any): void {
    const track = publication?.track;
    const sid = publication?.trackSid ?? publication?.sid ?? track?.sid ?? `track-${this.audioElements.size}`;
    if (!track || this.audioElements.has(sid)) return;

    const el = document.createElement("audio");
    el.autoplay = true;
    el.muted = this.muted;
    el.style.display = "none";
    try {
      track.attach?.(el);
      document.body.appendChild(el);
      this.audioElements.set(sid, el);
      this.livekitTracks.set(sid, track);
      this.installAnalyser(track, el);
      void el.play().catch((e) => {
        this.lastPlayError = e instanceof Error ? e.message : String(e);
        this.onLog?.("audio_play_error", { trackSid: sid, error: this.lastPlayError });
      });
      this.onLog?.("audio_track_attached", {
        trackSid: sid,
        analyserReady: Boolean(this.analyser),
        audioContextState: this.audioContext?.state ?? "none",
      });
    } catch (e) {
      this.lastAttachError = e instanceof Error ? e.message : String(e);
      this.onLog?.("audio_attach_error", { trackSid: sid, error: this.lastAttachError });
    }
  }

  private installAnalyser(track: any, el: HTMLAudioElement): void {
    if (this.analyser) return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    this.audioContext = new Ctor();
    try {
      this.analyser = this.audioContext.createAnalyser();
      this.analyser.fftSize = 512;
      this.scratch = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
      this.outputGain = this.audioContext.createGain();
      this.outputGain.gain.value = this.muted ? 0 : 1;
      const mediaStreamTrack = track.mediaStreamTrack ?? track._mediaStreamTrack;
      if (mediaStreamTrack) {
        const stream = new MediaStream([mediaStreamTrack]);
        this.mediaSource = this.audioContext.createMediaStreamSource(stream);
        this.mediaSource.connect(this.analyser);
        this.onLog?.("audio_analyser_stream_source", { trackId: mediaStreamTrack.id });
      } else {
        this.mediaSource = this.audioContext.createMediaElementSource(el);
        this.mediaSource.connect(this.analyser);
        this.analyser.connect(this.outputGain);
        this.outputGain.connect(this.audioContext.destination);
        this.onLog?.("audio_analyser_element_source");
      }
    } catch (e) {
      this.lastAttachError = e instanceof Error ? e.message : String(e);
      this.onLog?.("audio_analyser_error", { error: this.lastAttachError });
    }
  }
}
