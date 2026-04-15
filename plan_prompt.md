Design and scaffold a production-ready open-source project called **PandaShare** with the following requirements.

---

# 🧠 PROJECT OVERVIEW

PandaShare is a browser-based file sharing platform with:

* Room-based file sharing
* Optional end-to-end encryption (zero-knowledge)
* Chunked upload/download for large files
* S3-compatible object storage
* Clean, modern UX

Tech stack:

* Frontend: Next.js (App Router, TypeScript)
* Backend: Node.js (preferably with Fastify or Express)
* Database: PostgreSQL (preferred) or MongoDB
* Storage: AWS S3 or S3-compatible (MinIO for local dev)

---

# 🔐 CORE FEATURE: DUAL MODE FILE SHARING

Each room has a fixed mode:

## 1. Password-Protected Mode (DEFAULT)

* Auto-generate strong password (editable by user)
* Use PBKDF2 (SHA-256, high iterations) to derive key
* AES-256-GCM encryption in browser
* Chunked encryption and upload
* Server never sees password or key (zero-knowledge)

## 2. Public Mode (NO ENCRYPTION)

* User can toggle OFF encryption
* Files uploaded directly to S3 (no encryption)
* Files downloadable via pre-signed URLs
* Must clearly warn user that files are NOT secure

---

# ⚠️ STRICT SECURITY REQUIREMENTS

* Encryption MUST happen only in browser (Web Crypto API)
* NEVER send password to backend
* NEVER store password or key
* AES-GCM must use unique IV per chunk
* Use baseIV + chunkIndex strategy
* Salt must be random per room
* Pre-signed URLs must be short-lived (15–30 min)
* Room mode must be immutable after creation

---

# 🧱 BACKEND DESIGN

Design a clean API with:

## Routes:

* POST /rooms → create room
* GET /rooms/:id → get metadata
* POST /upload/:room/:fileId/:chunkIndex → upload chunk
* POST /complete/:room → finalize upload
* GET /download/:room/:fileId/:chunkIndex → download chunk
* GET /file/:room/:fileId/url → generate pre-signed URL (public mode)

## Responsibilities:

* Store metadata (room, files, chunk count, mode)
* Handle chunk uploads
* Generate pre-signed URLs
* Validate inputs
* Enforce rate limiting

## Database Schema:

Rooms:

* id
* name
* mode ("password" | "public")
* salt (nullable)
* baseIV (nullable)
* createdAt
* expiresAt

Files:

* id
* roomId
* fileName
* totalChunks
* size

---

# ☁️ STORAGE DESIGN

Use S3 structure:

* encrypted/{roomId}/{fileId}.{chunkIndex}
* public/{roomId}/{fileId}

Support:

* Multipart uploads (optional future)
* Local MinIO for development

---

# 🧩 FRONTEND DESIGN (Next.js)

## Pages:

* Home (create room)
* Room page (upload/download UI)

## UX Requirements:

### Create Room UI

* Auto-generate:

  * Room name (human readable)
  * Password (high entropy)
* Editable fields
* Toggle:
  [✓] Encrypt files with password (default ON)

If OFF:

* Show warning:
  “Files will not be encrypted. Anyone with link can access them.”

---

## Upload UX

* Drag & drop support
* Show upload progress per file
* Chunked upload with retry
* Show encryption progress

---

## Download UX

### Password mode:

* Ask for password
* Decrypt in browser
* Save using File System Access API

### Public mode:

* Direct download via pre-signed URL

---

# ⚙️ CRYPTO MODULE (IMPORTANT)

Implement a reusable crypto module:

Functions:

* generateSalt()
* generateBaseIV()
* deriveKey(password, salt)
* encryptChunk(buffer, key, chunkIndex, baseIV)
* decryptChunk(buffer, key, chunkIndex, baseIV)

Must use:

* Web Crypto API
* AES-GCM
* PBKDF2

---

# 🚀 PERFORMANCE REQUIREMENTS

* Chunk size: ~5MB
* Support files up to multiple GB
* Memory usage must stay low (no full file buffering)
* Use streaming where possible (future enhancement)

---

# 🔁 FUTURE EXTENSIONS (design for them)

* Resume upload
* Retry failed chunks
* Streaming decryption
* File expiry cleanup job
* Max file size limits
* Rate limiting

---

# 🧪 DEVELOPMENT SETUP

* Use Docker for:

  * PostgreSQL
  * MinIO
* Provide seed scripts
* Environment-based config

---

# 📦 OUTPUT EXPECTATION

Generate:

1. Folder structure (frontend + backend)
2. API design with request/response schemas
3. Database schema (SQL or ORM like Prisma)
4. Core crypto module (frontend)
5. Sample Next.js pages (UI skeleton)
6. Backend server setup
7. S3 integration layer
8. Clear separation of concerns

---

# 🎯 GOAL

The output should be:

* Cleanly structured
* Secure by design
* Production-scalable
* Easy for contributors to understand (open-source friendly)

Avoid shortcuts, hacks, or insecure patterns.
