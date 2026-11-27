import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CloseIcon, MicIcon, StopIcon } from "./ComposerIcons.tsx";
import type { ChatMessage } from "../shared/chat.ts";
import { loadRate, RATES, recognitionClass, recognitionErrorText, replyAfter, requestMic, saveRate, type SpeechRecognitionLike } from "./conversation.ts";

// Conversation mode (task 123): opens the mic and puts what was said into the composer (task 138: never
// sent automatically). Once the user sends it, it waits for the reply, reads it aloud, then turns the
// mic back on by itself. If the browser refuses without a tap, the big mic button is the fallback. Recognition and synthesis are the browser's
// (on-device recognition where it offers it). The turn's reply is whatever the agent said after the
// message was sent, read once it has stopped working. The start button, and End while on, are icon
// buttons in the composer row (`slot`); once on, the big mic and its phase show above the composer.

type Phase = "off" | "listening" | "drafted" | "waiting" | "speaking" | "ready";

const NEEDS_TAP = "The browser wouldn't turn the mic back on by itself. Tap the mic to speak.";

const LABEL: Record<Phase, string> = { off: "", listening: "Listening…", drafted: "Check it, then send. Tap to add more", waiting: "Claude is working… (tap to stop waiting)", speaking: "Speaking…", ready: "Tap to speak" };

interface ConversationProps {
  readonly paneId: string;
  readonly messages: readonly ChatMessage[];
  readonly working: boolean;
  /** Where the start button goes: the composer row. */
  readonly slot: HTMLElement | null;
  /** Puts what was heard into the composer. */
  readonly onHeard: (text: string) => void;
  /** Goes up by one each time the composer sends a message. */
  readonly sent: number;
}

/** The mode, when this browser has speech recognition and synthesis. */
export function Conversation(props: ConversationProps) {
  const supported = typeof window !== "undefined" && recognitionClass() !== null && "speechSynthesis" in window;
  return supported ? <ConversationMode {...props} /> : null;
}

function ConversationMode({ messages, working, slot, onHeard, sent }: ConversationProps) {
  const [phase, setPhase] = useState<Phase>("off");
  const [error, setError] = useState("");
  const [heard, setHeard] = useState("");
  const [rate, setRate] = useState(loadRate);
  const rateRef = useRef(rate);
  rateRef.current = rate;
  const rec = useRef<SpeechRecognitionLike | null>(null);
  const utterance = useRef<SpeechSynthesisUtterance | null>(null);
  const baseline = useRef(0);
  // The turn counts as over only after the agent was seen working: a status that has not flipped yet is not "done".
  const sawWorking = useRef(false);
  const latest = useRef(messages);
  latest.current = messages;

  const stopSpeech = () => {
    // Detached first: browsers fire the utterance's error event after a cancel.
    if (utterance.current !== null) {
      utterance.current.onend = null;
      utterance.current.onerror = null;
      utterance.current = null;
    }
    window.speechSynthesis.cancel();
  };
  // Bumped by every stop, so a mic prompt still pending when the user ends the mode starts nothing.
  const attempt = useRef(0);
  const stopAll = () => {
    attempt.current += 1;
    if (rec.current !== null) {
      const r = rec.current;
      rec.current = null;
      r.abort();
    }
    stopSpeech();
  };
  // ChatView is keyed by pane, so unmounting is how the mode ends on another pane.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- stopAll only touches refs
  useEffect(() => stopAll, []);

  const listen = (auto = false) => {
    setError("");
    setHeard("");
    setPhase("listening");
    // The mic is requested explicitly first: recognition alone can start without ever prompting (or fail silently).
    const mine = ++attempt.current;
    void requestMic().then((denied) => {
      if (attempt.current !== mine) return;
      if (denied !== "") {
        setError(auto && denied === "NotAllowedError" ? NEEDS_TAP : recognitionErrorText(denied));
        setPhase("ready");
      } else startRecognition(auto);
    });
  };
  const startRecognition = (auto: boolean) => {
    const Recognition = recognitionClass();
    if (Recognition === null) return;
    const r = new Recognition();
    r.lang = navigator.language;
    r.continuous = false;
    r.interimResults = true;
    let said = "";
    r.onresult = (e) => {
      said = Array.from(e.results, (res) => res[0]?.transcript ?? "").join(" ").trim();
      setHeard(said);
    };
    r.onerror = (e) => {
      setError(auto && (e.error === "not-allowed" || e.error === "service-not-allowed") ? NEEDS_TAP : recognitionErrorText(e.error));
    };
    r.onend = () => {
      if (rec.current !== r) return;
      rec.current = null;
      if (said === "") {
        setPhase("ready");
        return;
      }
      onHeard(said);
      setPhase("drafted");
    };
    rec.current = r;
    try {
      r.start();
    } catch {
      rec.current = null;
      setError("Couldn't start speech recognition.");
      setPhase("ready");
    }
  };

  // The composer sent a message: the turn starts, and its reply is what comes after this point.
  const lastSent = useRef(sent);
  useEffect(() => {
    if (sent === lastSent.current) return;
    lastSent.current = sent;
    if (phase === "off") return;
    stopAll();
    baseline.current = latest.current.length;
    sawWorking.current = false;
    setHeard("");
    setError("");
    setPhase("waiting");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only a send starts a turn
  }, [sent]);

  // The turn ends when the agent stops working after having worked: read what it said. With nothing to read yet
  // (the transcript can trail the status; or only tools, an interrupt, a question on screen) it keeps waiting,
  // and the mic button stops the wait.
  useEffect(() => {
    if (phase !== "waiting") return;
    if (working) {
      sawWorking.current = true;
      return;
    }
    if (!sawWorking.current) return;
    const reply = replyAfter(messages, baseline.current);
    if (reply === "") return;
    setPhase("speaking");
    const u = new SpeechSynthesisUtterance(reply);
    u.lang = navigator.language;
    u.rate = rateRef.current;
    const done = () => {
      if (utterance.current === u) utterance.current = null;
      listen(true);
    };
    u.onend = done;
    u.onerror = done;
    utterance.current = u; // held: Chrome drops the end event of a collected utterance
    window.speechSynthesis.speak(u);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- listen only touches refs and setters
  }, [phase, working, messages]);

  const end = () => {
    stopAll();
    setPhase("off");
  };
  const button =
    slot === null
      ? null
      : createPortal(
          phase === "off" ? (
            <button type="button" className="composer-btn" data-testid="conv-start" aria-label="Conversation mode" title="Conversation mode" onClick={() => listen()}>
              <MicIcon />
            </button>
          ) : (
            <button type="button" className="composer-btn composer-end" data-testid="conv-end" aria-label="End conversation" title="End conversation" onClick={end}>
              <CloseIcon />
            </button>
          ),
          slot,
        );
  if (phase === "off") return button;
  return (
    <>
      {button}
      <section className="conv" data-testid="conv" data-phase={phase}>
        <button
          type="button"
          className="conv-mic"
          data-testid="conv-mic"
          aria-label={phase === "ready" || phase === "drafted" ? "Speak" : LABEL[phase]}
          onClick={() => {
            if (phase === "ready" || phase === "drafted") listen();
            else if (phase === "listening" && rec.current !== null) rec.current.stop();
            else {
              stopAll();
              setPhase("ready");
            }
          }}
        >
          <MicIcon />
        </button>
        <div className="conv-state" data-testid="conv-state" role="status">
          {LABEL[phase]}
        </div>
        {heard !== "" && phase === "listening" && <div className="conv-heard" data-testid="conv-heard">{heard}</div>}
        {error !== "" && (
          <div className="input-error" role="alert" data-testid="conv-error">
            {error}
          </div>
        )}
        <div className="conv-tools">
          {phase === "speaking" && (
            <button
              type="button"
              className="btn conv-stop"
              data-testid="conv-stop"
              onClick={() => {
                stopSpeech();
                setPhase("ready");
              }}
            >
              <StopIcon /> Stop speaking
            </button>
          )}
          <label className="conv-rate">
            Speed
            <select
              data-testid="conv-rate"
              value={String(rate)}
              onChange={(e) => {
                const n = Number(e.target.value);
                setRate(n);
                saveRate(n);
              }}
            >
              {RATES.map((r) => (
                <option key={r} value={String(r)}>
                  {r}×
                </option>
              ))}
            </select>
          </label>
        </div>
      </section>
    </>
  );
}
