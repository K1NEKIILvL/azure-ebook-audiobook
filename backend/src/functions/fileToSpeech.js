const { app } = require("@azure/functions");
const axios = require("axios");
const speechsdk = require("microsoft-cognitiveservices-speech-sdk");
const { BlobServiceClient } = require("@azure/storage-blob");
const fs = require("fs");
const path = require("path");
const os = require("os");

/* =========================
   Blob helper
========================= */
function getBlobServiceClient() {
  const connStr =
    `DefaultEndpointsProtocol=https;AccountName=${process.env.STORAGE_ACCOUNT_NAME};` +
    `AccountKey=${process.env.STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
  return BlobServiceClient.fromConnectionString(connStr);
}

/* =========================
   Document Intelligence with SAS
========================= */
async function extractTextWithDocIntel(blobName) {
  const endpoint = process.env.DOCINTEL_ENDPOINT.replace(/\/$/, "");
  const key = process.env.DOCINTEL_KEY;

  // 1️⃣ Generate SAS URL for the private blob
  const blobServiceClient = getBlobServiceClient();
  const containerClient = blobServiceClient.getContainerClient("books");
  const blobClient = containerClient.getBlobClient(blobName);

  const sasUrl = await blobClient.generateSasUrl({
    permissions: "r",
    expiresOn: new Date(Date.now() + 15 * 60 * 1000) // 15 minutes
  });

  // 2️⃣ Call Document Intelligence (prebuilt-read)
  const apiVersion = "2023-07-31";
  const analyzeUrl =
    `${endpoint}/formrecognizer/documentModels/prebuilt-read:analyze` +
    `?api-version=${apiVersion}`;

  const start = await axios.post(
    analyzeUrl,
    { urlSource: sasUrl },
    {
      headers: {
        "Ocp-Apim-Subscription-Key": key,
        "Content-Type": "application/json"
      }
    }
  );

  const opLoc = start.headers["operation-location"];
  if (!opLoc) throw new Error("Missing operation-location header");

  // 3️⃣ Poll for result
  for (let i = 0; i < 30; i++) {
    const r = await axios.get(opLoc, {
      headers: { "Ocp-Apim-Subscription-Key": key }
    });

    if (r.data.status === "succeeded") {
      const pages = r.data.analyzeResult.pages || [];
      const lines = [];

      for (const p of pages) {
        for (const l of (p.lines || [])) {
          lines.push(l.content);
        }
      }

      return lines.join("\n");
    }

    if (r.data.status === "failed") {
      throw new Error("Document Intelligence analysis failed");
    }

    await new Promise(res => setTimeout(res, 1000));
  }

  throw new Error("Document Intelligence timed out");
}

/* =========================
   Text → MP3
========================= */
async function textToMp3File(text, outPath, voice = "en-US-JennyNeural") {
  const speechConfig = speechsdk.SpeechConfig.fromSubscription(
    process.env.SPEECH_KEY,
    process.env.SPEECH_REGION
  );
  speechConfig.speechSynthesisVoiceName = voice;

  const audioConfig = speechsdk.AudioConfig.fromAudioFileOutput(outPath);
  const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);

  await new Promise((resolve, reject) => {
    synthesizer.speakTextAsync(
      text,
      () => {
        synthesizer.close();
        resolve();
      },
      err => {
        synthesizer.close();
        reject(err);
      }
    );
  });
}

/* =========================
   HTTP FUNCTION
========================= */
app.http("fileToSpeech", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    try {
      const body = await request.json().catch(() => ({}));
      const fileUrl = body.fileUrl;
      const voice = body.voice || "en-US-JennyNeural";

      if (!fileUrl) {
        return { status: 400, body: "Missing fileUrl in JSON body" };
      }

      // Extract blob name from URL
      const blobName = fileUrl.split("/").pop();

      // 1️⃣ OCR
      const extractedText = await extractTextWithDocIntel(blobName);

      if (!extractedText || extractedText.trim().length === 0) {
        return { status: 422, body: "No text extracted from document." };
      }

      // 2️⃣ Limit text for safety
      const MAX_CHARS = 5000;
      const textForTts =
        extractedText.length > MAX_CHARS
          ? extractedText.slice(0, MAX_CHARS)
          : extractedText;

      // 3️⃣ Text → MP3 (temp file)
      const mp3Path = path.join(os.tmpdir(), `ebook-${Date.now()}.mp3`);
      await textToMp3File(textForTts, mp3Path, voice);

      // 4️⃣ Upload MP3
      const blobServiceClient = getBlobServiceClient();
      const audioContainer = blobServiceClient.getContainerClient("audio");
      await audioContainer.createIfNotExists();

      const audioBlobName = `ebook-${Date.now()}.mp3`;
      const audioBlobClient = audioContainer.getBlockBlobClient(audioBlobName);

      await audioBlobClient.uploadFile(mp3Path, {
        blobHTTPHeaders: { blobContentType: "audio/mpeg" }
      });

      fs.unlinkSync(mp3Path);

      return {
        status: 200,
        jsonBody: {
          message: "File -> Text -> Speech done",
          extractedChars: extractedText.length,
          usedCharsForTts: textForTts.length,
          blobName: audioBlobName,
          audioUrl: audioBlobClient.url
        }
      };
    } catch (err) {
      context.log.error(err);
      return {
        status: 500,
        body: err.message || "Internal Server Error"
      };
    }
  }
});
