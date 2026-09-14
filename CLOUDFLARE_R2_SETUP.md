# Pixora — Cloudflare R2 setup

Pixora now uploads input images directly from the browser to Cloudflare R2 using short-lived presigned URLs. Vercel Blob is no longer used by the application upload flow.

## 1. Create an R2 bucket

1. Open Cloudflare Dashboard.
2. Go to **R2 Object Storage**.
3. Create a bucket. Recommended name: `pixora-inputs`.
4. Keep the standard/default storage class.

## 2. Create R2 S3 API credentials

Create an R2 API token / S3 credentials that can read and write objects in this bucket.

Copy these values immediately:

- Account ID
- Access Key ID
- Secret Access Key
- Bucket name

Do not put the secret values in GitHub or client-side code.

## 3. Add Vercel environment variables

In the Pixora Vercel project, open **Settings → Environment Variables** and add:

```text
R2_ACCOUNT_ID=YOUR_CLOUDFLARE_ACCOUNT_ID
R2_ACCESS_KEY_ID=YOUR_R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY=YOUR_R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME=pixora-inputs
```

Keep the existing `VMODEL_API_TOKEN` variable.

`BLOB_READ_WRITE_TOKEN` is no longer required by Pixora and can be removed after the R2 migration is working.

Apply the R2 variables to Production and, if you use them, Preview/Development environments. Redeploy Pixora after saving them.

## 4. Configure R2 CORS

The browser uploads directly to R2, so the bucket must allow `PUT` requests from the Pixora website origin.

In the bucket's CORS settings, use a rule like this and replace the example origin with the real Pixora URL:

```json
[
  {
    "AllowedOrigins": [
      "https://YOUR-PIXORA-DOMAIN"
    ],
    "AllowedMethods": [
      "PUT"
    ],
    "AllowedHeaders": [
      "Content-Type"
    ],
    "ExposeHeaders": [
      "ETag"
    ],
    "MaxAgeSeconds": 3600
  }
]
```

For local development, add your local origin as another item in `AllowedOrigins`, for example `http://localhost:3000`.

## 5. Auto-delete temporary input images

Pixora stores uploaded source images under the `pixora-inputs/` prefix. Add an R2 lifecycle rule that expires objects under this prefix after **1 day**.

Recommended rule:

- Prefix: `pixora-inputs/`
- Action: Expire/Delete
- Age: 1 day

This keeps temporary source images from building up in storage.

## How the new upload flow works

1. Pixora asks its server for a short-lived R2 upload URL.
2. The browser uploads the image directly to R2 with a presigned `PUT` URL.
3. Pixora receives a separate temporary presigned `GET` URL.
4. That GET URL is sent to VModel V-Editor as the input image URL.
5. R2 lifecycle cleanup removes the temporary source object later.

The R2 Access Key ID and Secret Access Key never go to the browser. Only temporary object-specific presigned URLs are returned.

## Current limits in Pixora

- Image formats: PNG, JPEG, WEBP
- Maximum file size: 12 MB per image
- Batch size: up to 50 images
- Upload presigned URL validity: 15 minutes
- VModel read URL validity: 6 hours
