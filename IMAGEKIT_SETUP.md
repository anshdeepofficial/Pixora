# Pixora — ImageKit setup

Pixora now uses ImageKit instead of Vercel Blob or Cloudflare R2 for image storage.

## Required Vercel environment variables

In the Pixora Vercel project, open **Settings → Environment Variables** and add:

```text
IMAGEKIT_PUBLIC_KEY=your_public_key
IMAGEKIT_PRIVATE_KEY=your_private_key
IMAGEKIT_URL_ENDPOINT=https://ik.imagekit.io/your_imagekit_id
```

Keep the existing VModel variable:

```text
VMODEL_API_TOKEN=your_vmodel_api_token
```

If the admin panel is used to save a VModel key override, also keep `PIXORA_ADMIN_SECRET` configured.

After changing environment variables, redeploy the project so the new values are available to the server routes.

## Storage behavior

- Browser uploads go directly to ImageKit under `/pixora-inputs/`.
- The ImageKit private key never goes to browser code. The server only returns short-lived upload authentication parameters.
- Input uploads are queued for deletion 15 minutes after upload while the page is open.
- As a fallback, inputs older than 1 hour are removed when Pixora's stats endpoint runs.
- Successful VModel outputs are copied to `/pixora-results/` so download and 24-hour history URLs stay stable.
- Result files older than 24 hours are automatically cleaned up when the stats endpoint runs.
- The 50-image batch limit and 12 MB-per-image Pixora limit are unchanged.

## VModel admin override

The encrypted VModel admin override is also stored in ImageKit under `/pixora-private/` rather than Vercel Blob. The encrypted file still requires `PIXORA_ADMIN_SECRET` to decrypt it.

## Old storage variables

These are no longer required by the Pixora application flow and can be removed after ImageKit is confirmed working:

```text
BLOB_READ_WRITE_TOKEN
R2_ACCOUNT_ID
R2_ACCESS_KEY_ID
R2_SECRET_ACCESS_KEY
R2_BUCKET_NAME
```
