# Tencent COS CORS for Local H5 Upload

## Current diagnosis

The H5 multipart upload flow is working up to the point where the browser starts sending `PUT` requests directly to Tencent COS.

What has already been verified locally:

- `POST /upload/multipart/init` returns `200`
- `POST /upload/multipart/part` returns `200`
- Direct command-line `PUT` to the presigned COS URL returns `200`
- Browser-style `OPTIONS` preflight to the same COS URL returns `403`

That means:

- the app code is generating valid multipart upload sessions
- the presigned COS URL is valid
- COS credentials and bucket name are valid
- the current blocker is COS CORS, not the Next.js upload code

## What to configure in Tencent COS

Open the Tencent Cloud COS console for bucket `15630198311-1419857142`, then add a CORS rule.

Use these values for local debugging:

- Origin: `http://127.0.0.1:3002`
- Methods: `GET`, `POST`, `PUT`, `HEAD`, `OPTIONS`
- Allowed Headers: `*`
- Expose Headers: `ETag`
- Max Age: `3600`

If you also test with another local origin, add it too:

- `http://localhost:3002`

For the real deployment page, also add the production H5 domain, for example:

- `https://api.capego.top`

## Recommended rule set

If the COS console asks for JSON, use the equivalent structure below:

```json
[
  {
    "AllowedOrigins": [
      "http://127.0.0.1:3002",
      "http://localhost:3002",
      "https://api.capego.top"
    ],
    "AllowedMethods": [
      "GET",
      "POST",
      "PUT",
      "HEAD",
      "OPTIONS"
    ],
    "AllowedHeaders": [
      "*"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

## Why `ETag` matters

The browser must be able to read the `ETag` response header after each part upload. Without that header:

- the file part may actually reach COS
- but the H5 page cannot confirm the part upload
- the upload UI will treat the part as failed

## After saving the COS rule

1. Wait about 1-2 minutes for the COS CORS rule to take effect.
2. Go back to the H5 page.
3. Click the button that discards the unfinished upload session, or start a fresh upload.
4. Re-upload the same video with code `000001`.

## Expected database changes after it works

During upload:

- `upload_sessions` will contain one row with `status = uploading`
- `uploaded_parts` will gradually fill up

After upload is completed:

- `upload_sessions.status` becomes `completed`
- `video_submissions` gets a new row

