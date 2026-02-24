# Encrypted Room-Based File Sharing Prototype - Architecture - Prototype

## Overview

This project implements:

* Room-based file sharing
* Same password per room
* Client-side AES-256-GCM encryption
* Chunked encryption and upload
* Chunked download and decryption
* Zero-knowledge server model (server never sees password or key)
* Local disk storage (for prototype)

---

# 1. Security Model

### Zero Knowledge Design

* Password never sent to server
* Encryption happens in browser
* Server stores only encrypted chunks
* Decryption happens in browser
* Wrong password fails AES-GCM authentication

---

# 2. Encryption Design

## Algorithm

* Key derivation: PBKDF2 (SHA-256)
* Encryption: AES-256-GCM
* Iterations: 100,000
* Key length: 256 bits
* Chunk size: 5MB

---

## Key Derivation

```ts
deriveKey(password, salt) → AES-GCM CryptoKey
```

Process:

1. Import password as raw key material
2. Use PBKDF2 with:

   * salt (16 random bytes)
   * 100,000 iterations
   * SHA-256
3. Derive AES-256-GCM key

---

## IV Strategy

Each room generates:

* `baseIV` (12 random bytes)

Each chunk uses:

```
chunkIV = baseIV + chunkIndex
```

Implementation:

* Copy baseIV
* Write chunkIndex into last 4 bytes using DataView

This ensures:

* Unique IV per chunk
* Same key safe across chunks
* AES-GCM remains secure

---

# 3. Upload Flow (Chunked Encryption + Upload)

## Step 1 – Create Room

```
POST /api/rooms
```

Body:

```json
{
  "roomName": "test",
  "expiresInHours": 24,
  "salt": [...],
  "baseIV": [...]
}
```

Server:

* Creates room folder
* Stores metadata in memory
* Returns success

---

## Step 2 – Encrypt and Upload in Chunks

For each chunk:

1. Slice file:

```
chunk = file.slice(offset, offset + CHUNK_SIZE)
```

2. Convert to ArrayBuffer
3. Derive IV for this chunk
4. Encrypt chunk:

```
AES-GCM(key, chunkIV, chunkBuffer)
```

5. Upload encrypted chunk:

```
POST /api/upload/:room/:fileId/:chunkIndex
Content-Type: application/octet-stream
Body: encryptedBuffer
```

6. Repeat until file complete

---

## Step 3 – Finalize Upload

```
POST /api/complete/:room
```

Body:

```json
{
  "fileId": "...",
  "fileName": "...",
  "totalChunks": 42
}
```

Server stores:

* fileId
* fileName
* totalChunks

---

# 4. Server Storage Structure

```
storage/
  roomName/
    fileId.0.part
    fileId.1.part
    fileId.2.part
    ...
```

Each `.part` file is:

* AES-GCM encrypted
* Independently decryptable
* Authenticated via GCM tag

---

# 5. Download Flow (Chunked Download + Decryption)

## Step 1 – Fetch Room Metadata

```
GET /api/rooms/:roomName
```

Response:

```json
{
  "salt": [...],
  "baseIV": [...],
  "files": [
    {
      "fileId": "...",
      "fileName": "...",
      "totalChunks": 42
    }
  ]
}
```

---

## Step 2 – Derive Key

Browser:

```
key = deriveKey(password, salt)
```

---

## Step 3 – Download and Decrypt Each Chunk

For each chunk index:

1. Download encrypted chunk:

```
GET /api/download/:room/:fileId/:chunkIndex
```

Response type: `arraybuffer`

2. Derive IV for chunk
3. Decrypt:

```
AES-GCM(key, chunkIV, encryptedBuffer)
```

4. Store decrypted Uint8Array

Repeat until all chunks downloaded.

---

## Step 4 – Combine File

After all chunks:

```
blob = new Blob(decryptedChunks)
```

Trigger browser download:

```
URL.createObjectURL(blob)
```

---

# 6. Why Chunked Architecture

Without chunking:

* 1GB file requires ~2GB RAM during encrypt/decrypt
* Browser crashes likely

With chunking:

* Memory usage ≈ chunk size only (5MB)
* More stable
* Scalable to large files

---

# 7. Axios Usage Strategy

Two types of requests:

### JSON API calls

Used for:

* /rooms
* /complete
* /rooms/:id

Axios instance:

* Content-Type: application/json

---

### Binary Upload

Used for:

* /upload/:room/:fileId/:chunkIndex

Custom config:

* Content-Type: application/octet-stream
* maxBodyLength: Infinity
* maxContentLength: Infinity
* onUploadProgress enabled

---

### Binary Download

Used for:

* /download/:room/:fileId/:chunkIndex

Axios config:

* responseType: "arraybuffer"
* onDownloadProgress enabled

---

# 8. Security Guarantees

| Component        | Server Sees | Server Cannot See |
| ---------------- | ----------- | ----------------- |
| Password         | ❌           | ✔                 |
| Encryption Key   | ❌           | ✔                 |
| File Content     | ❌           | ✔                 |
| Salt             | ✔           |                   |
| Base IV          | ✔           |                   |
| Encrypted Chunks | ✔           |                   |

AES-GCM ensures:

* Integrity verification
* Wrong password fails decryption

---

# 9. Limitations (Current Prototype)

* Metadata stored in memory
* No persistent database
* Full file assembled in memory before save
* No resumable uploads
* No rate limiting
* No expiry cleanup job

---

# 10. Future Improvements

* Stream decryption to disk (no large Blob)
* Retry per chunk
* Resume upload support
* Multipart S3 storage
* Room expiry auto-delete
* Rate limiting
* Password in URL fragment support
* Admin-configurable max file size
* File count limits per room

---

# 11. High-Level Flow Summary

## Upload

```
User selects file
↓
Generate salt + baseIV
↓
Derive key
↓
For each chunk:
    Encrypt
    Upload
↓
Finalize upload
```

---

## Download

```
User enters password
↓
Fetch metadata
↓
Derive key
↓
For each chunk:
    Download
    Decrypt
↓
Combine and save
```

---

# Final Notes

This prototype provides:

* Secure client-side encryption
* Zero-knowledge storage
* Memory-safe chunk handling
* Clean separation of encryption and transport

This architecture can now be extended with:

* S3 multipart uploads
* Streaming decryption
* Production-grade scalability
