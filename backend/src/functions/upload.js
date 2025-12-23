const { app } = require("@azure/functions");
const { BlobServiceClient } = require("@azure/storage-blob");

function getBlobServiceClient() {
  const connStr =
    `DefaultEndpointsProtocol=https;AccountName=${process.env.STORAGE_ACCOUNT_NAME};` +
    `AccountKey=${process.env.STORAGE_ACCOUNT_KEY};EndpointSuffix=core.windows.net`;
  return BlobServiceClient.fromConnectionString(connStr);
}

app.http("upload", {
  methods: ["POST"],
  authLevel: "anonymous",
  handler: async (request, context) => {
    // Expect raw bytes with header: x-filename
    const filename = request.headers.get("x-filename");
    const contentType = request.headers.get("content-type") || "application/octet-stream";

    if (!filename) {
      return { status: 400, body: "Missing header: x-filename" };
    }

    const body = Buffer.from(await request.arrayBuffer());
    if (!body || body.length === 0) {
      return { status: 400, body: "Empty body. Send file bytes in request body." };
    }

    const blobServiceClient = getBlobServiceClient();
    const containerClient = blobServiceClient.getContainerClient("books");
    await containerClient.createIfNotExists();

    const safeName = `${Date.now()}-${filename}`;
    const blobClient = containerClient.getBlockBlobClient(safeName);

    await blobClient.uploadData(body, {
      blobHTTPHeaders: { blobContentType: contentType }
    });

    return {
      status: 200,
      jsonBody: {
        message: "Uploaded",
        blobName: safeName,
        fileUrl: blobClient.url
      }
    };
  }
});
