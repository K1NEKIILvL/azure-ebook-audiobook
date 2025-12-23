const { app } = require("@azure/functions");
const speechsdk = require("microsoft-cognitiveservices-speech-sdk");
const { BlobServiceClient } = require("@azure/storage-blob");
const fs = require("fs");
const path = require("path");
const os = require("os");

app.http("textToSpeech", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    const body = await request.json().catch(() => ({}));
    const text = body.text;

    if (!text) {
      return { status: 400, body: "Please provide text" };
    }

    // Temp file path (safe for Azure Functions)
    const tempFile = path.join(os.tmpdir(), `speech-${Date.now()}.mp3`);

    // Speech config
    const speechConfig = speechsdk.SpeechConfig.fromSubscription(
      process.env.SPEECH_KEY,
      process.env.SPEECH_REGION
    );
    speechConfig.speechSynthesisVoiceName = "en-US-JennyNeural";

    const audioConfig = speechsdk.AudioConfig.fromAudioFileOutput(tempFile);
    const synthesizer = new speechsdk.SpeechSynthesizer(speechConfig, audioConfig);

    // Generate speech
    await new Promise((resolve, reject) => {
      synthesizer.speakTextAsync(
        text,
        result => {
          synthesizer.close();
          resolve(result);
        },
        err => {
          synthesizer.close();
          reject(err);
        }
      );
    });

    // Upload to Blob Storage
    const connStr =
      `DefaultEndpointsProtocol=https;AccountName=${process.env.STORAGE_ACCOUNT_NAME};` +
      `AccountKey=${process.env.STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`;

    const blobServiceClient = BlobServiceClient.fromConnectionString(connStr);
    const containerClient = blobServiceClient.getContainerClient("audio");
    await containerClient.createIfNotExists();

    const blobName = `speech-${Date.now()}.mp3`;
    const blockBlobClient = containerClient.getBlockBlobClient(blobName);

    await blockBlobClient.uploadFile(tempFile, {
      blobHTTPHeaders: { blobContentType: "audio/mpeg" }
    });

    // Cleanup temp file
    fs.unlinkSync(tempFile);

    return {
      status: 200,
      jsonBody: {
        message: "Speech generated successfully",
        blobName
      }
    };
  }
});
