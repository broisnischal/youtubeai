import { useCallback, useEffect, useRef, useState } from "react";
import { useDropzone } from "react-dropzone-esm";
import constants from "~/constants";
import { useTranscriber } from "~/hooks/useTranscriber";
import { TranscribeButton } from "./TranscriberButton";
import Transcript from "./Transcript";
import { pipeline } from "@xenova/transformers";

// @ts-ignore
const IS_WEBGPU_AVAILABLE = !!navigator.gpu;

const MODELS = Object.entries({
  // Original checkpoints
  "onnx-community/whisper-tiny": 120, // 33 + 87
  "onnx-community/whisper-base": 206, // 83 + 123
  "onnx-community/whisper-small": 586, // 353 + 233
  "onnx-community/whisper-large-v3-turbo": 1604, // 1270 + 334

  // Distil Whisper (English-only)
  "onnx-community/distil-small.en": 538, // 353 + 185
});

export enum AudioSource {
  FILE = "FILE",
}

export default function MyDropzone() {
  const transcriber = useTranscriber();
  const worker = useRef<Worker | null>(null);

  // Model loading and progress
  const [status, setStatus] = useState<"loading" | "ready" | null>(null);
  const [error, setError] = useState(null);
  const [loadingMessage, setLoadingMessage] = useState<string>("");
  const [progressItems, setProgressItems] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  // Inputs and outputs
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<any[]>([]);
  const [tps, setTps] = useState(null);
  const [numTokens, setNumTokens] = useState(null);

  function onEnter(message: string) {
    setMessages((prev) => [...prev, { role: "user", content: message }]);
    setTps(null);
    setIsRunning(true);
    setInput("");
  }

  function onInterrupt() {
    // NOTE: We do not set isRunning to false here because the worker
    // will send a 'complete' message when it is done.
    worker?.current?.postMessage({ type: "interrupt" });
  }

  // We use the `useEffect` hook to setup the worker as soon as the `App` component is mounted.
  useEffect(() => {
    // Create the worker if it does not yet exist.
    if (!worker.current) {
      worker.current = new Worker(
        new URL("../llm-worker.js", import.meta.url),
        {
          type: "module",
        }
      );
      worker.current.postMessage({ type: "check" }); // Do a feature check
    }

    // Create a callback function for messages from the worker thread.
    const onMessageReceived = (e: any) => {
      switch (e.data.status) {
        case "loading":
          // Model file start load: add a new progress item to the list.
          setStatus("loading");
          setLoadingMessage(e.data.data);
          break;

        case "initiate":
          setProgressItems((prev) => [...prev, e.data]);
          break;

        case "progress":
          // Model file progress: update one of the progress items.
          setProgressItems((prev) =>
            prev.map((item) => {
              if (item.file === e.data.file) {
                return { ...item, ...e.data };
              }
              return item;
            })
          );
          break;

        case "done":
          // Model file loaded: remove the progress item from the list.
          setProgressItems((prev) =>
            prev.filter((item) => item.file !== e.data.file)
          );
          break;

        case "ready":
          // Pipeline ready: the worker is ready to accept messages.
          setStatus("ready");
          break;

        case "start":
          {
            // Start generation
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: "" },
            ]);
          }
          break;

        case "update":
          {
            // Generation update: update the output text.
            // Parse messages
            const { output, tps, numTokens } = e.data;
            setTps(tps);
            setNumTokens(numTokens);
            setMessages((prev) => {
              const cloned = [...prev];
              const last = cloned.at(-1);
              cloned[cloned.length - 1] = {
                ...last,
                content: last.content + output,
              };
              return cloned;
            });
          }
          break;

        case "complete":
          // Generation complete: re-enable the "Generate" button
          setIsRunning(false);
          break;

        case "error":
          setError(e.data.data);
          break;
      }
    };

    const onErrorReceived = (e: any) => {
      console.error("Worker error:", e);
    };

    // Attach the callback function as an event listener.
    worker.current.addEventListener("message", onMessageReceived);
    worker.current.addEventListener("error", onErrorReceived);

    // Define a cleanup function for when the component is unmounted.
    return () => {
      if (worker.current) {
        worker.current.removeEventListener("message", onMessageReceived);
        worker.current.removeEventListener("error", onErrorReceived);
      }
    };
  }, []);

  // Send the messages to the worker thread whenever the `messages` state changes.
  useEffect(() => {
    if (messages.filter((x) => x.role === "user").length === 0) {
      // No user messages yet: do nothing.
      return;
    }
    if (messages.at(-1).role === "assistant") {
      // Do not update if the last message is from the assistant
      return;
    }
    setTps(null);
    worker?.current?.postMessage({ type: "generate", data: messages });
  }, [messages, isRunning]);

  const [progress, setProgress] = useState<number | undefined>(0);

  const [audioData, setAudioData] = useState<
    | {
        buffer: AudioBuffer;
        url: string;
        source: AudioSource;
        mimeType: string;
      }
    | undefined
  >(undefined);

  const resetAudio = () => {
    setAudioData(undefined);
  };

  const onDrop = useCallback((acceptedFiles: any) => {}, []);
  const { getRootProps, getInputProps, isDragActive, acceptedFiles } =
    useDropzone({ onDrop });

  if (!IS_WEBGPU_AVAILABLE) {
    return <div>No web gpu available in this machine.</div>;
  }

  const setAudioFromDownload = async (data: ArrayBuffer, mimeType: string) => {
    const audioCTX = new AudioContext({
      sampleRate: constants.SAMPLING_RATE,
    });
    const blobUrl = URL.createObjectURL(new Blob([data], { type: "audio/*" }));
    const decoded = await audioCTX.decodeAudioData(data);
    setAudioData({
      buffer: decoded,
      url: blobUrl,
      source: AudioSource.FILE,
      mimeType: mimeType,
    });
  };

  const texts = transcriber.output?.chunks
    .map((chunk) => chunk.text)
    .join("")
    .trim();

  const divRef = useRef<HTMLDivElement>(null);

  const [generatedTitle, setGeneratedTitle] = useState<string | undefined>(
    undefined
  );

  const generateTitle = async (value: string) => {
    // if (!value) return;

    // const generator = await pipeline("text-generation", "Xenova/gpt2");

    // const output = await generator(text, {
    //   max_new_tokens: 20,
    //   do_sample: true,
    //   top_k: 5,
    // });

    // console.log(output);

    const generator = await pipeline(
      "text-generation",
      "Xenova/Qwen1.5-0.5B-Chat"
    );

    const prompt = "Give me a short introduction to large language model.";
    const messages = [
      { role: "system", content: "You are a helpful assistant." },
      { role: "user", content: prompt },
    ];

    const text = generator.tokenizer.apply_chat_template(messages, {
      tokenize: false,
      add_generation_prompt: true,
    });

    const output = await generator(text as any, {
      max_new_tokens: 128,
      do_sample: false,
      return_full_text: false,
    });

    console.log(output);

    // setGeneratedTitle(output.);
  };

  useEffect(() => {
    if (divRef.current) {
      const diff = Math.abs(
        divRef.current.offsetHeight +
          divRef.current.scrollTop -
          divRef.current.scrollHeight
      );

      if (diff <= 100) {
        // We're close enough to the bottom, so scroll to the bottom
        divRef.current.scrollTop = divRef.current.scrollHeight;
      }
    }
  });

  const [generatedDescription, setGeneratedDescription] = useState<
    string | undefined
  >(undefined);

  const generateTitleAndDescription = async (text: string) => {
    if (!text) return;

    setGeneratedTitle("Generating...");
    setGeneratedDescription("Generating...");

    try {
      const generator = await pipeline(
        "text-generation",
        "Xenova/Qwen1.5-0.5B-Chat"
      );

      const titlePrompt = "Generate a short, catchy title for this transcript:";
      const descriptionPrompt =
        "Generate a brief description for this transcript:";

      const titleMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: `${titlePrompt}\n\n${text}` },
      ];

      const descriptionMessages = [
        { role: "system", content: "You are a helpful assistant." },
        { role: "user", content: `${descriptionPrompt}\n\n${text}` },
      ];

      const titleText = generator.tokenizer.apply_chat_template(titleMessages, {
        tokenize: false,
        add_generation_prompt: true,
      });

      const descriptionText = generator.tokenizer.apply_chat_template(
        descriptionMessages,
        {
          tokenize: false,
          add_generation_prompt: true,
        }
      );

      const titleOutput = await generator(titleText as any, {
        max_new_tokens: 50,
        do_sample: false,
        return_full_text: false,
      });

      const descriptionOutput = await generator(descriptionText as any, {
        max_new_tokens: 150,
        do_sample: false,
        return_full_text: false,
      });

      console.log(titleOutput);
      console.log(descriptionOutput);

      // @ts-ignore
      setGeneratedTitle(titleOutput[0].generated_text.trim());
      // @ts-ignore
      setGeneratedDescription(descriptionOutput[0].generated_text.trim());
    } catch (error) {
      console.error("Error generating title and description:", error);
      setGeneratedTitle("Error generating title");
      setGeneratedDescription("Error generating description");
    }
  };

  return (
    <>
      <FileTile
        icon={<div>File</div>}
        text={"From file"}
        onFileUpdate={(decoded, blobUrl, mimeType) => {
          transcriber.onInputChange();
          setAudioData({
            buffer: decoded,
            url: blobUrl,
            source: AudioSource.FILE,
            mimeType: mimeType,
          });
        }}
      />

      <TranscribeButton
        onClick={() => {
          transcriber.start(audioData?.buffer);
        }}
        isModelLoading={transcriber.isModelLoading}
        isTranscribing={transcriber.isBusy}
      />

      {/* <Transcript transcribedData={transcriber.output} /> */}

      <div
        ref={divRef}
        className="w-full flex flex-col my-2 p-4 overflow-y-auto max-h-[50rem]"
      >
        {texts}
      </div>

      {transcriber.isBusy ? (
        <div>Transcribing...</div>
      ) : (
        <div>
          <button
            onClick={() => {
              generateTitleAndDescription(texts ?? "");
            }}
            className="px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 transition-colors"
          >
            Generate Title and Description
          </button>

          {generatedTitle && (
            <div className="mt-4">
              <h3 className="font-bold">Generated Title:</h3>
              <p>{generatedTitle}</p>
            </div>
          )}

          {generatedDescription && (
            <div className="mt-4">
              <h3 className="font-bold">Generated Description:</h3>
              <p>{generatedDescription}</p>
            </div>
          )}
        </div>
      )}
    </>
  );
}

function FileTile(props: {
  icon: JSX.Element;
  text: string;
  onFileUpdate: (
    decoded: AudioBuffer,
    blobUrl: string,
    mimeType: string
  ) => void;
}) {
  // Create hidden input element
  const { getRootProps, getInputProps, isDragActive } = useDropzone();

  const [file, setFile] = useState<File | null>(null);

  const elem = document.createElement("input");
  elem.type = "file";
  elem.oninput = (event) => {
    // Make sure we have files to use
    const files = (event.target as HTMLInputElement).files;
    if (!files) return;

    // Create a blob that we can use as an src for our audio element
    const urlObj = URL.createObjectURL(files[0]);
    const mimeType = files[0].type;

    const reader = new FileReader();
    reader.addEventListener("load", async (e) => {
      const arrayBuffer = e.target?.result as ArrayBuffer; // Get the ArrayBuffer
      if (!arrayBuffer) return;

      const audioCTX = new AudioContext({
        sampleRate: constants.SAMPLING_RATE,
      });

      const decoded = await audioCTX.decodeAudioData(arrayBuffer);

      props.onFileUpdate(decoded, urlObj, mimeType);
    });
    reader.readAsArrayBuffer(files[0]);
    setFile(files[0]);

    // Reset files
    elem.value = "";
  };

  return (
    <div onClick={() => elem.click()}>
      {file ? (
        <video controls className="w-1/3 mb-4 mx-auto">
          <source src={URL.createObjectURL(file)} type={file.type} />
          Your browser does not support the video tag.
        </video>
      ) : (
        <div
          className={`border-2 h-[40vh] flex items-center justify-center border-dashed rounded-lg p-8 text-center transition-colors duration-300 ${
            isDragActive
              ? "border-green-500 bg-green-500/20"
              : "border-gray-300 hover:border-gray-400"
          }`}
        >
          <div>
            <p className="text-gray-600 mb-2">
              Drag 'n' drop a video file here, or click to select
            </p>
            <svg
              className="mx-auto h-12 w-12 text-gray-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12"
              />
            </svg>
          </div>
        </div>
      )}
    </div>
  );
}
