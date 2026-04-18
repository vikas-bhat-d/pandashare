# PandaShare — Step-by-Step Implementation Guide

> **Purpose**: This document is the canonical implementation reference for PandaShare.
> Any agent or developer working on this project should read this file first.
> Each step is ordered by dependency — do NOT skip ahead.

---

## Table of Contents

1. [Project Context](#1-project-context)
2. [Architecture Summary](#2-architecture-summary)
3. [Step 0 — Frontend Cleanup](#step-0--frontend-cleanup)
4. [Step 1 — Backend Project Scaffold](#step-1--backend-project-scaffold)
5. [Step 2 — Database Schema & Prisma](#step-2--database-schema--prisma)
6. [Step 3 — Docker Services (PostgreSQL + MinIO)](#step-3--docker-services-postgresql--minio)
7. [Step 4 — Backend API — Room Routes](#step-4--backend-api--room-routes)
8. [Step 5 — Backend API — S3 Storage Service](#step-5--backend-api--s3-storage-service)
9. [Step 6 — Backend API — Upload Routes](#step-6--backend-api--upload-routes)
10. [Step 7 — Backend API — Download Routes](#step-7--backend-api--download-routes)
11. [Step 8 — Backend Middleware (Validation, Rate Limit, Error Handling)](#step-8--backend-middleware)
12. [Step 9 — Frontend — Replace Mock API with Real HTTP Calls](#step-9--frontend--replace-mock-api)
13. [Step 10 — Frontend — Upload Pipeline (Real Crypto)](#step-10--frontend--upload-pipeline)
14. [Step 11 — Frontend — Download Pipeline (Real Crypto)](#step-11--frontend--download-pipeline)
15. [Step 12 — Frontend — Wire Pipelines to UI](#step-12--frontend--wire-pipelines-to-ui)
16. [Step 13 — Room Routing & Password Handling](#step-13--room-routing--password-handling)
17. [Step 14 — UX Polish](#step-14--ux-polish)
18. [Step 15 — Testing](#step-15--testing)
19. [Step 16 — Deployment & README](#step-16--deployment--readme)

---

## 1. Project Context

PandaShare is a browser-based file sharing platform with:

- **Room-based sharing** — files are grouped by rooms
- **Dual mode** — Password-protected (E2EE) or Public (no encryption)
- **Zero-knowledge** — server never sees passwords or encryption keys
- **Chunked transfers** — 5MB chunks for large file support
- **Client-side encryption** — AES-256-GCM via Web Crypto API

### Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Next.js 16 (App Router), TypeScript, Tailwind CSS v4 |
| Backend | Node.js, Express, TypeScript |
| Database | PostgreSQL 16 (via Prisma ORM) |
| Storage | MinIO (S3-compatible, for dev) / AWS S3 (prod) |
| Crypto | Web Crypto API (browser-only) |

### Repository Structure (Target)

```
PandaShare/
├── pandashare-frontend/      # Next.js app
│   ├── app/
│   │   ├── page.tsx           # Landing page
│   │   └── room/
│   │       └── page.tsx       # Room page (hash-based routing)
│   ├── components/
│   │   ├── RoomFilesGrid.tsx  # Main file grid (upload + download)
│   │   └── ui/                # Primitives (Button, Card, Input, Toggle)
│   └── utils/
│       ├── api.ts             # HTTP API client
│       ├── apiClient.ts       # Fetch wrapper
│       ├── crypto.ts          # Web Crypto functions
│       ├── uploadPipeline.ts  # Chunked encrypt + upload orchestrator
│       ├── downloadPipeline.ts # Chunked download + decrypt orchestrator
│       └── utils.ts           # Misc utilities
├── pandashare-backend/        # Express API server
│   ├── prisma/
│   │   └── schema.prisma
│   ├── src/
│   │   ├── index.ts           # Server entrypoint
│   │   ├── config.ts          # Environment config
│   │   ├── routes/
│   │   │   ├── rooms.ts
│   │   │   ├── upload.ts
│   │   │   └── download.ts
│   │   ├── services/
│   │   │   ├── room.service.ts
│   │   │   ├── file.service.ts
│   │   │   └── storage.service.ts
│   │   ├── middleware/
│   │   │   ├── rateLimit.ts
│   │   │   ├── validate.ts
│   │   │   └── errorHandler.ts
│   │   └── types/
│   │       └── index.ts
│   ├── docker-compose.yml
│   ├── .env.example
│   └── package.json
├── implementation.md          # ← This file
├── encryption strategy.md     # Crypto architecture reference
├── plan_prompt.md             # Original project spec
└── README.md
```

---

## 2. Architecture Summary

### Security Model

```
PASSWORD is NEVER sent to server.
KEY is NEVER sent to server.
FILE CONTENT is NEVER visible to server.

Server stores ONLY:
  - Room metadata (name, mode, salt, baseIV, expiry)
  - File metadata (fileName, totalChunks, size)
  - Encrypted binary chunks (opaque blobs)
```

### Encryption Pipeline

```
Password → PBKDF2(SHA-256, 100K iterations, salt) → AES-256-GCM Key

For chunk[i]:
  IV = baseIV XOR chunkIndex (last 4 bytes)
  encrypted = AES-GCM(key, IV, chunk)
```

### S3 Object Layout

```
Bucket: pandashare
  encrypted/{roomId}/{fileId}.{chunkIndex}    # Password mode
  public/{roomId}/{fileId}                     # Public mode (single object)
```

---

## Step 0 — Frontend Cleanup

**Goal**: Remove dead code, fix known issues in existing frontend.

### Actions

1. **Delete unused files**:
   - `app/room/[id]/page.tsx` (entire `[id]` directory)
   - `components/CreateRoom.tsx`
   - `components/FileUploader.tsx`
   - `components/FileDownloader.tsx`

2. **Fix `layout.tsx`**: Change `font-serif` → `font-mono` in body class

3. **Fix `app/page.tsx`**:
   - Add an encryption toggle (currently mode is inferred from password presence)
   - Show password field only when encryption is ON
   - Add public mode warning when encryption is OFF

4. **Add drag & drop to `RoomFilesGrid.tsx`**:
   - Add `onDragEnter`, `onDragOver`, `onDragLeave`, `onDrop` handlers to upload card
   - Visual indicator when dragging files over

5. **Verify build**:
   ```bash
   cd pandashare-frontend && npm run build
   ```
   Ensure zero errors.

### Validation
- `npm run build` succeeds
- No unused imports or references after cleanup

---

## Step 1 — Backend Project Scaffold

**Goal**: Create the Express + TypeScript project with all dependencies.

### Actions

1. Create `pandashare-backend/` directory

2. Initialize:
   ```bash
   cd pandashare-backend
   npm init -y
   ```

3. Install dependencies:
   ```bash
   # Runtime
   npm install express cors helmet dotenv zod @prisma/client @aws-sdk/client-s3 @aws-sdk/s3-request-presigner express-rate-limit

   # Dev
   npm install -D typescript @types/express @types/cors @types/node ts-node-dev prisma vitest
   ```

4. Create `tsconfig.json`:
   ```json
   {
     "compilerOptions": {
       "target": "ES2022",
       "module": "CommonJS",
       "lib": ["ES2022"],
       "outDir": "./dist",
       "rootDir": "./src",
       "strict": true,
       "esModuleInterop": true,
       "skipLibCheck": true,
       "forceConsistentCasingInFileNames": true,
       "resolveJsonModule": true,
       "declaration": true,
       "declarationMap": true,
       "sourceMap": true
     },
     "include": ["src/**/*"],
     "exclude": ["node_modules", "dist"]
   }
   ```

5. Add scripts to `package.json`:
   ```json
   {
     "scripts": {
       "dev": "ts-node-dev --respawn --transpile-only src/index.ts",
       "build": "tsc",
       "start": "node dist/index.js",
       "db:push": "prisma db push",
       "db:generate": "prisma generate",
       "db:studio": "prisma studio",
       "test": "vitest"
     }
   }
   ```

6. Create `src/index.ts` — basic Express server:
   ```typescript
   import express from "express";
   import cors from "cors";
   import helmet from "helmet";
   import { config } from "./config";
   import { errorHandler } from "./middleware/errorHandler";
   import roomRoutes from "./routes/rooms";
   import uploadRoutes from "./routes/upload";
   import downloadRoutes from "./routes/download";

   const app = express();

   app.use(helmet());
   app.use(cors({ origin: config.CORS_ORIGIN }));
   app.use(express.json());

   // Routes
   app.use("/api", roomRoutes);
   app.use("/api", uploadRoutes);
   app.use("/api", downloadRoutes);

   // Health check
   app.get("/health", (_, res) => res.json({ status: "ok" }));

   // Error handler (must be last)
   app.use(errorHandler);

   app.listen(config.PORT, () => {
     console.log(`PandaShare API running on port ${config.PORT}`);
   });
   ```

7. Create `src/config.ts`:
   ```typescript
   import dotenv from "dotenv";
   dotenv.config();

   export const config = {
     PORT: parseInt(process.env.PORT || "4000"),
     CORS_ORIGIN: process.env.CORS_ORIGIN || "http://localhost:3000",
     DATABASE_URL: process.env.DATABASE_URL || "",
     S3_ENDPOINT: process.env.S3_ENDPOINT || "http://localhost:9000",
     S3_ACCESS_KEY: process.env.S3_ACCESS_KEY || "minioadmin",
     S3_SECRET_KEY: process.env.S3_SECRET_KEY || "minioadmin",
     S3_BUCKET: process.env.S3_BUCKET || "pandashare",
     S3_REGION: process.env.S3_REGION || "us-east-1",
     MAX_FILE_SIZE: 2 * 1024 * 1024 * 1024, // 2GB
     CHUNK_SIZE: 5 * 1024 * 1024, // 5MB
     MAX_EXPIRY_HOURS: 48,
   };
   ```

8. Create `.env.example`:
   ```
   PORT=4000
   CORS_ORIGIN=http://localhost:3000
   DATABASE_URL=postgresql://pandashare:pandashare_dev@localhost:5432/pandashare
   S3_ENDPOINT=http://localhost:9000
   S3_ACCESS_KEY=minioadmin
   S3_SECRET_KEY=minioadmin
   S3_BUCKET=pandashare
   S3_REGION=us-east-1
   ```

### Validation
- `npm run dev` starts without errors
- `GET http://localhost:4000/health` returns `{ status: "ok" }`

---

## Step 2 — Database Schema & Prisma

**Goal**: Define the data model and generate Prisma client.

### Actions

1. Initialize Prisma:
   ```bash
   npx prisma init
   ```

2. Write `prisma/schema.prisma`:
   ```prisma
   generator client {
     provider = "prisma-client-js"
   }

   datasource db {
     provider = "postgresql"
     url      = env("DATABASE_URL")
   }

   model Room {
     id        String   @id @default(cuid())
     name      String   @unique
     mode      RoomMode
     salt      String?
     baseIV    String?
     createdAt DateTime @default(now())
     expiresAt DateTime
     files     File[]

     @@index([name])
     @@index([expiresAt])
   }

   model File {
     id          String   @id @default(cuid())
     roomId      String
     room        Room     @relation(fields: [roomId], references: [id], onDelete: Cascade)
     fileName    String
     totalChunks Int
     size        BigInt
     uploadedAt  DateTime @default(now())
     isComplete  Boolean  @default(false)

     @@index([roomId])
   }

   enum RoomMode {
     password
     public
   }
   ```

3. Push to database:
   ```bash
   npx prisma db push
   npx prisma generate
   ```

### Validation
- `npx prisma studio` opens and shows empty Room/File tables
- Prisma Client is generated without errors

---

## Step 3 — Docker Services (PostgreSQL + MinIO)

**Goal**: Containerized development dependencies.

### Actions

1. Create `docker-compose.yml` in `pandashare-backend/`:
   ```yaml
   version: '3.8'
   services:
     postgres:
       image: postgres:16-alpine
       environment:
         POSTGRES_DB: pandashare
         POSTGRES_USER: pandashare
         POSTGRES_PASSWORD: pandashare_dev
       ports:
         - "5432:5432"
       volumes:
         - pgdata:/var/lib/postgresql/data
       healthcheck:
         test: ["CMD-SHELL", "pg_isready -U pandashare"]
         interval: 5s
         timeout: 5s
         retries: 5

     minio:
       image: minio/minio
       command: server /data --console-address ":9001"
       environment:
         MINIO_ROOT_USER: minioadmin
         MINIO_ROOT_PASSWORD: minioadmin
       ports:
         - "9000:9000"
         - "9001:9001"
       volumes:
         - miniodata:/data
       healthcheck:
         test: ["CMD", "curl", "-f", "http://localhost:9000/minio/health/live"]
         interval: 5s
         timeout: 5s
         retries: 5

   volumes:
     pgdata:
     miniodata:
   ```

2. Start services:
   ```bash
   docker-compose up -d
   ```

3. Create MinIO bucket:
   - Open `http://localhost:9001` (MinIO Console)
   - Login: `minioadmin` / `minioadmin`
   - Create bucket named `pandashare`

   OR via CLI:
   ```bash
   # Install mc (MinIO Client) and configure
   mc alias set local http://localhost:9000 minioadmin minioadmin
   mc mb local/pandashare
   ```

### Validation
- `docker-compose ps` shows both services healthy
- PostgreSQL is accessible at `localhost:5432`
- MinIO Console loads at `http://localhost:9001`
- Bucket `pandashare` exists

---

## Step 4 — Backend API — Room Routes

**Goal**: CRUD endpoints for rooms.

### Actions

1. Create `src/services/room.service.ts`:
   ```typescript
   import { PrismaClient, RoomMode } from "@prisma/client";

   const prisma = new PrismaClient();

   interface CreateRoomInput {
     name: string;
     mode: RoomMode;
     salt?: string;
     baseIV?: string;
     expiresInHours?: number;
   }

   export async function createRoom(input: CreateRoomInput) {
     const expiresAt = new Date(
       Date.now() + (input.expiresInHours || 24) * 60 * 60 * 1000
     );

     return prisma.room.create({
       data: {
         name: input.name,
         mode: input.mode,
         salt: input.salt,
         baseIV: input.baseIV,
         expiresAt,
       },
     });
   }

   export async function getRoom(nameOrId: string) {
     // Try by ID first, then by name
     let room = await prisma.room.findUnique({
       where: { id: nameOrId },
       include: { files: { where: { isComplete: true } } },
     });

     if (!room) {
       room = await prisma.room.findUnique({
         where: { name: nameOrId },
         include: { files: { where: { isComplete: true } } },
       });
     }

     // Check expiry
     if (room && new Date(room.expiresAt) < new Date()) {
       return null; // Expired
     }

     return room;
   }

   export async function updateExpiry(id: string, hours: number) {
     const maxHours = Math.min(hours, 48);
     const expiresAt = new Date(Date.now() + maxHours * 60 * 60 * 1000);
     return prisma.room.update({
       where: { id },
       data: { expiresAt },
     });
   }
   ```

2. Create `src/routes/rooms.ts`:
   ```typescript
   import { Router } from "express";
   import { z } from "zod";
   import * as roomService from "../services/room.service";

   const router = Router();

   const createRoomSchema = z.object({
     name: z.string().min(1).max(100),
     mode: z.enum(["password", "public"]),
     salt: z.string().optional(),
     baseIV: z.string().optional(),
     expiresInHours: z.number().min(1).max(48).optional(),
   });

   // POST /api/rooms
   router.post("/rooms", async (req, res, next) => {
     try {
       const data = createRoomSchema.parse(req.body);
       const room = await roomService.createRoom(data);
       res.status(201).json(room);
     } catch (err) {
       next(err);
     }
   });

   // GET /api/rooms/:nameOrId
   router.get("/rooms/:nameOrId", async (req, res, next) => {
     try {
       const room = await roomService.getRoom(req.params.nameOrId);
       if (!room) return res.status(404).json({ error: "Room not found or expired" });
       res.json(room);
     } catch (err) {
       next(err);
     }
   });

   // PATCH /api/rooms/:id/expiry
   router.patch("/rooms/:id/expiry", async (req, res, next) => {
     try {
       const { hours } = z.object({ hours: z.number().min(1).max(48) }).parse(req.body);
       const room = await roomService.updateExpiry(req.params.id, hours);
       res.json({ expiresAt: room.expiresAt });
     } catch (err) {
       next(err);
     }
   });

   export default router;
   ```

### Validation
- `POST /api/rooms` with `{ name: "Test-Room-1", mode: "password" }` returns 201 with room data
- `GET /api/rooms/Test-Room-1` returns the room with empty files array
- `PATCH /api/rooms/:id/expiry` with `{ hours: 12 }` updates expiresAt

---

## Step 5 — Backend API — S3 Storage Service

**Goal**: Abstraction layer for MinIO/S3 operations.

### Actions

1. Create `src/services/storage.service.ts`:
   ```typescript
   import {
     S3Client,
     PutObjectCommand,
     GetObjectCommand,
     DeleteObjectCommand,
     DeleteObjectsCommand,
   } from "@aws-sdk/client-s3";
   import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
   import { config } from "../config";
   import { Readable } from "stream";

   const s3 = new S3Client({
     endpoint: config.S3_ENDPOINT,
     region: config.S3_REGION,
     credentials: {
       accessKeyId: config.S3_ACCESS_KEY,
       secretAccessKey: config.S3_SECRET_KEY,
     },
     forcePathStyle: true, // Required for MinIO
   });

   function getChunkKey(roomId: string, fileId: string, chunkIndex: number): string {
     return `encrypted/${roomId}/${fileId}.${chunkIndex}`;
   }

   function getPublicKey(roomId: string, fileId: string): string {
     return `public/${roomId}/${fileId}`;
   }

   export async function uploadChunk(
     roomId: string,
     fileId: string,
     chunkIndex: number,
     body: Buffer
   ): Promise<void> {
     await s3.send(
       new PutObjectCommand({
         Bucket: config.S3_BUCKET,
         Key: getChunkKey(roomId, fileId, chunkIndex),
         Body: body,
         ContentType: "application/octet-stream",
       })
     );
   }

   export async function downloadChunk(
     roomId: string,
     fileId: string,
     chunkIndex: number
   ): Promise<Readable> {
     const response = await s3.send(
       new GetObjectCommand({
         Bucket: config.S3_BUCKET,
         Key: getChunkKey(roomId, fileId, chunkIndex),
       })
     );
     return response.Body as Readable;
   }

   export async function deleteFileChunks(
     roomId: string,
     fileId: string,
     totalChunks: number
   ): Promise<void> {
     const objects = Array.from({ length: totalChunks }, (_, i) => ({
       Key: getChunkKey(roomId, fileId, i),
     }));

     await s3.send(
       new DeleteObjectsCommand({
         Bucket: config.S3_BUCKET,
         Delete: { Objects: objects },
       })
     );
   }

   export async function getPresignedDownloadUrl(
     roomId: string,
     fileId: string
   ): Promise<string> {
     const command = new GetObjectCommand({
       Bucket: config.S3_BUCKET,
       Key: getPublicKey(roomId, fileId),
     });
     return getSignedUrl(s3, command, { expiresIn: 900 }); // 15 min
   }

   // Public mode: upload entire file as one object
   export async function uploadPublicFile(
     roomId: string,
     fileId: string,
     body: Buffer
   ): Promise<void> {
     await s3.send(
       new PutObjectCommand({
         Bucket: config.S3_BUCKET,
         Key: getPublicKey(roomId, fileId),
         Body: body,
         ContentType: "application/octet-stream",
       })
     );
   }
   ```

### Validation
- Write a small test script that uploads a buffer to MinIO and retrieves it
- Verify the object appears in MinIO Console under `pandashare` bucket

---

## Step 6 — Backend API — Upload Routes

**Goal**: Accept chunked binary uploads and store to S3.

### Actions

1. Create `src/services/file.service.ts`:
   ```typescript
   import { PrismaClient } from "@prisma/client";

   const prisma = new PrismaClient();

   export async function completeUpload(data: {
     fileId: string;
     roomId: string;
     fileName: string;
     totalChunks: number;
     size: number;
   }) {
     return prisma.file.upsert({
       where: { id: data.fileId },
       update: {
         isComplete: true,
         totalChunks: data.totalChunks,
         size: BigInt(data.size),
       },
       create: {
         id: data.fileId,
         roomId: data.roomId,
         fileName: data.fileName,
         totalChunks: data.totalChunks,
         size: BigInt(data.size),
         isComplete: true,
       },
     });
   }

   export async function getFile(roomId: string, fileId: string) {
     return prisma.file.findFirst({
       where: { id: fileId, roomId },
     });
   }

   export async function deleteFile(fileId: string) {
     return prisma.file.delete({ where: { id: fileId } });
   }
   ```

2. Create `src/routes/upload.ts`:
   ```typescript
   import { Router } from "express";
   import { z } from "zod";
   import * as storage from "../services/storage.service";
   import * as fileService from "../services/file.service";

   const router = Router();

   // Important: We need raw body for binary uploads
   // POST /api/upload/:roomId/:fileId/:chunkIndex
   router.post(
     "/upload/:roomId/:fileId/:chunkIndex",
     express.raw({ type: "application/octet-stream", limit: "6mb" }),
     async (req, res, next) => {
       try {
         const { roomId, fileId, chunkIndex } = req.params;
         const idx = parseInt(chunkIndex);
         if (isNaN(idx) || idx < 0) {
           return res.status(400).json({ error: "Invalid chunk index" });
         }

         await storage.uploadChunk(roomId, fileId, idx, req.body);
         res.json({ ok: true });
       } catch (err) {
         next(err);
       }
     }
   );

   // POST /api/complete/:roomId
   router.post("/complete/:roomId", async (req, res, next) => {
     try {
       const schema = z.object({
         fileId: z.string(),
         fileName: z.string(),
         totalChunks: z.number().int().positive(),
         size: z.number().positive(),
       });
       const data = schema.parse(req.body);
       await fileService.completeUpload({ ...data, roomId: req.params.roomId });
       res.json({ ok: true });
     } catch (err) {
       next(err);
     }
   });

   export default router;
   ```

### ⚠️ Important Note on `express.raw()`
The upload route MUST use `express.raw()` middleware to parse the binary body. This is separate from the global `express.json()`. The route-level middleware takes priority.

### Validation
- Upload a test chunk:
  ```bash
  curl -X POST http://localhost:4000/api/upload/testroom/testfile/0 \
    -H "Content-Type: application/octet-stream" \
    --data-binary @testfile.bin
  ```
- Verify chunk appears in MinIO at `encrypted/testroom/testfile.0`

---

## Step 7 — Backend API — Download Routes

**Goal**: Stream chunks from S3 and serve pre-signed URLs.

### Actions

1. Create `src/routes/download.ts`:
   ```typescript
   import { Router } from "express";
   import * as storage from "../services/storage.service";
   import * as fileService from "../services/file.service";

   const router = Router();

   // GET /api/download/:roomId/:fileId/:chunkIndex
   router.get("/download/:roomId/:fileId/:chunkIndex", async (req, res, next) => {
     try {
       const { roomId, fileId, chunkIndex } = req.params;
       const idx = parseInt(chunkIndex);

       const stream = await storage.downloadChunk(roomId, fileId, idx);
       res.set("Content-Type", "application/octet-stream");
       stream.pipe(res);
     } catch (err) {
       next(err);
     }
   });

   // GET /api/files/:roomId/:fileId/url (public mode only)
   router.get("/files/:roomId/:fileId/url", async (req, res, next) => {
     try {
       const { roomId, fileId } = req.params;
       const url = await storage.getPresignedDownloadUrl(roomId, fileId);
       res.json({ url });
     } catch (err) {
       next(err);
     }
   });

   // DELETE /api/files/:roomId/:fileId
   router.delete("/files/:roomId/:fileId", async (req, res, next) => {
     try {
       const { roomId, fileId } = req.params;
       const file = await fileService.getFile(roomId, fileId);
       if (!file) return res.status(404).json({ error: "File not found" });

       await storage.deleteFileChunks(roomId, fileId, file.totalChunks);
       await fileService.deleteFile(fileId);
       res.json({ ok: true });
     } catch (err) {
       next(err);
     }
   });

   export default router;
   ```

### Validation
- Download a previously uploaded chunk:
  ```bash
  curl http://localhost:4000/api/download/testroom/testfile/0 --output chunk.bin
  ```
- Compare with original: files should match byte-for-byte

---

## Step 8 — Backend Middleware

**Goal**: Add production-grade middleware.

### Actions

1. **`src/middleware/errorHandler.ts`**:
   ```typescript
   import { Request, Response, NextFunction } from "express";
   import { ZodError } from "zod";

   export function errorHandler(err: any, req: Request, res: Response, next: NextFunction) {
     console.error("[ERROR]", err);

     if (err instanceof ZodError) {
       return res.status(400).json({
         error: "Validation failed",
         details: err.errors,
       });
     }

     if (err.code === "P2002") {
       return res.status(409).json({ error: "Resource already exists" });
     }

     res.status(500).json({ error: "Internal server error" });
   }
   ```

2. **`src/middleware/rateLimit.ts`**:
   ```typescript
   import rateLimit from "express-rate-limit";

   export const apiLimiter = rateLimit({
     windowMs: 15 * 60 * 1000, // 15 minutes
     max: 100,
     message: { error: "Too many requests. Please try again later." },
   });

   export const uploadLimiter = rateLimit({
     windowMs: 60 * 1000, // 1 minute
     max: 60, // 60 chunks per minute (one 300MB file)
     message: { error: "Upload rate limit exceeded." },
   });
   ```

3. **`src/middleware/validate.ts`**:
   ```typescript
   import { Request, Response, NextFunction } from "express";
   import { ZodSchema } from "zod";

   export function validate(schema: ZodSchema) {
     return (req: Request, res: Response, next: NextFunction) => {
       try {
         schema.parse(req.body);
         next();
       } catch (err) {
         next(err);
       }
     };
   }
   ```

### Validation
- Send >100 requests in 15 minutes → should get 429 response
- Send invalid JSON to POST /api/rooms → should get structured Zod validation error

---

## Step 9 — Frontend — Replace Mock API

**Goal**: Replace all mock functions with real HTTP calls.

### Actions

1. Create `utils/apiClient.ts`:
   ```typescript
   const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";

   export async function apiJson<T>(
     path: string,
     options?: RequestInit
   ): Promise<T> {
     const res = await fetch(`${BASE_URL}${path}`, {
       headers: { "Content-Type": "application/json", ...options?.headers },
       ...options,
     });
     if (!res.ok) {
       const body = await res.json().catch(() => ({}));
       throw new Error(body.error || `API error: ${res.status}`);
     }
     return res.json();
   }

   export async function apiBinary(
     path: string,
     body: ArrayBuffer
   ): Promise<void> {
     const res = await fetch(`${BASE_URL}${path}`, {
       method: "POST",
       headers: { "Content-Type": "application/octet-stream" },
       body,
     });
     if (!res.ok) throw new Error(`Upload failed: ${res.status}`);
   }

   export async function apiDownload(path: string): Promise<ArrayBuffer> {
     const res = await fetch(`${BASE_URL}${path}`);
     if (!res.ok) throw new Error(`Download failed: ${res.status}`);
     return res.arrayBuffer();
   }
   ```

2. Rewrite `utils/api.ts` to use `apiClient`:
   - Every function becomes a thin wrapper around a `fetch` call
   - Remove `MOCK_DB` entirely
   - Remove simulated delays
   - Keep `toBase64` / `fromBase64` utility functions

3. Add `NEXT_PUBLIC_API_URL=http://localhost:4000` to `.env.local`

### Validation
- Frontend can create a room via the UI and it persists in PostgreSQL
- Page refresh still shows the room (data is no longer lost)

---

## Step 10 — Frontend — Upload Pipeline

**Goal**: Implement real chunked encryption + upload.

### Actions

1. Create `utils/uploadPipeline.ts`:
   ```typescript
   import { encryptChunk, deriveKey, generateSalt, generateBaseIV } from "./crypto";
   import { uploadChunk, completeUpload, createRoom, toBase64 } from "./api";

   const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB

   export interface UploadProgress {
     phase: "encrypting" | "uploading";
     chunkIndex: number;
     totalChunks: number;
     percent: number;
   }

   export async function uploadFile(
     file: File,
     roomId: string,
     mode: "password" | "public",
     password?: string,
     salt?: Uint8Array,
     baseIV?: Uint8Array,
     fileId?: string,
     onProgress?: (progress: UploadProgress) => void
   ): Promise<{ fileId: string; totalChunks: number }> {
     const id = fileId || crypto.randomUUID();
     const totalChunks = Math.ceil(file.size / CHUNK_SIZE);

     let key: CryptoKey | null = null;
     if (mode === "password" && password && salt) {
       key = await deriveKey(password, salt);
     }

     for (let i = 0; i < totalChunks; i++) {
       const start = i * CHUNK_SIZE;
       const end = Math.min(start + CHUNK_SIZE, file.size);
       let buffer = await file.slice(start, end).arrayBuffer();

       // Encrypt if password mode
       if (key && baseIV) {
         onProgress?.({
           phase: "encrypting",
           chunkIndex: i,
           totalChunks,
           percent: Math.round((i / totalChunks) * 100),
         });
         buffer = await encryptChunk(buffer, key, i, baseIV);
       }

       // Upload
       onProgress?.({
         phase: "uploading",
         chunkIndex: i,
         totalChunks,
         percent: Math.round(((i + 0.5) / totalChunks) * 100),
       });
       await uploadChunk(roomId, id, i, buffer);

       onProgress?.({
         phase: "uploading",
         chunkIndex: i,
         totalChunks,
         percent: Math.round(((i + 1) / totalChunks) * 100),
       });
     }

     // Finalize
     await completeUpload(roomId, id, {
       fileName: file.name,
       totalChunks,
       size: file.size,
     });

     return { fileId: id, totalChunks };
   }
   ```

### Validation
- Upload a 15MB file → verify 3 chunks appear in MinIO
- Verify each chunk is encrypted (not readable as plaintext)
- Progress callback fires with correct phase and percentages

---

## Step 11 — Frontend — Download Pipeline

**Goal**: Implement real chunked download + decryption.

### Actions

1. Create `utils/downloadPipeline.ts`:
   ```typescript
   import { decryptChunk, deriveKey } from "./crypto";
   import { downloadChunk, fromBase64 } from "./api";

   export interface DownloadProgress {
     phase: "downloading" | "decrypting";
     chunkIndex: number;
     totalChunks: number;
     percent: number;
   }

   export async function downloadFile(
     roomId: string,
     fileId: string,
     fileName: string,
     totalChunks: number,
     mode: "password" | "public",
     password?: string,
     salt?: string,     // base64
     baseIV?: string,   // base64
     onProgress?: (progress: DownloadProgress) => void
   ): Promise<void> {
     let key: CryptoKey | null = null;
     let baseIVBytes: Uint8Array | null = null;

     if (mode === "password" && password && salt && baseIV) {
       const saltBytes = fromBase64(salt);
       baseIVBytes = fromBase64(baseIV);
       key = await deriveKey(password, saltBytes);
     }

     const decryptedChunks: ArrayBuffer[] = [];

     for (let i = 0; i < totalChunks; i++) {
       onProgress?.({
         phase: "downloading",
         chunkIndex: i,
         totalChunks,
         percent: Math.round((i / totalChunks) * 50), // first 50% is download
       });

       let buffer = await downloadChunk(roomId, fileId, i);

       if (key && baseIVBytes) {
         onProgress?.({
           phase: "decrypting",
           chunkIndex: i,
           totalChunks,
           percent: 50 + Math.round((i / totalChunks) * 50), // second 50% is decrypt
         });

         try {
           buffer = await decryptChunk(buffer, key, i, baseIVBytes);
         } catch (err) {
           throw new Error("Decryption failed — incorrect password or corrupted data.");
         }
       }

       decryptedChunks.push(buffer);
     }

     // Assemble and trigger download
     const blob = new Blob(decryptedChunks);
     const url = URL.createObjectURL(blob);
     const a = document.createElement("a");
     a.href = url;
     a.download = fileName;
     document.body.appendChild(a);
     a.click();
     document.body.removeChild(a);
     URL.revokeObjectURL(url);

     onProgress?.({
       phase: "downloading",
       chunkIndex: totalChunks,
       totalChunks,
       percent: 100,
     });
   }
   ```

### ⚠️ Key Security Note
`decryptChunk` will throw an error if the password is wrong because AES-GCM authentication will fail. This is the *correct* behavior and is how we detect wrong passwords — there is no separate "password check" API. The error message should be user-friendly.

### Validation
- Upload a file with password "test123"
- Download with password "test123" → file matches original (check SHA-256)
- Download with password "wrong" → error: "Decryption failed"

---

## Step 12 — Frontend — Wire Pipelines to UI

**Goal**: Connect real upload/download pipelines to `RoomFilesGrid.tsx`.

### Actions

1. **Modify `RoomFilesGrid.tsx`**:
   - Import `uploadFile` from `uploadPipeline.ts`
   - Import `downloadFile` from `downloadPipeline.ts`
   - Replace simulation loops with real pipeline calls
   - Wire progress callbacks to update `FileTile.status` and `FileTile.progress`
   - Handle errors:
     - Upload failure → show retry button on file tile
     - Download/decrypt failure → show error message in modal

2. **Modify `app/room/page.tsx`**:
   - After room loads, pass `room.salt` and `room.baseIV` to `RoomFilesGrid`
   - On upload of first file to a new password room:
     - Generate salt + baseIV in browser
     - Send to API via room creation/update
   - Populate file list from `room.files[]` returned by API

3. **Modify `app/page.tsx`**:
   - On room creation (password mode):
     - Generate salt + baseIV using crypto.ts
     - Include in `createRoom()` call
     - Encode as base64 and store in room metadata

### Validation
- Full E2E: Create room → Upload file → Copy link → Open incognito → Enter password → Download → File is identical

---

## Step 13 — Room Routing & Password Handling

**Goal**: Robust URL-based room + password routing.

### Actions

1. **Encoding**: Use `encodeURIComponent` / `decodeURIComponent` on both room name and password in the URL hash
2. **Separator**: Use `|` instead of `,` as separator (less conflict with passwords)
3. **Format**: `#roomName|encoded_password`
4. **On room page load**:
   - Parse hash
   - If password present: store in component state (never in localStorage — too persistent)
   - If mode is "password" and no password: show unlock overlay
   - If mode is "public": show files immediately
5. **Copy link button**: Give option to "Copy link with password" or "Copy link only"

### Validation
- Password with special characters (e.g., `p@ss|w0rd!`) correctly round-trips through URL
- Opening link without password shows password prompt
- Public room link works without any password prompt

---

## Step 14 — UX Polish

**Goal**: Make it recruiter-grade.

### Actions

1. **Error Boundary**: `components/ErrorBoundary.tsx`
2. **Loading Skeletons**: Skeleton cards for file grid
3. **Empty State**: Illustrated empty state when room has no files
4. **Drag & Drop Visual Feedback**: Border glow + text change when dragging
5. **Staggered Tile Animation**: File tiles fade in with stagger
6. **Toast System**: Replace `alert()` with slide-in toasts
7. **Responsive**: Test on mobile viewport, ensure touch-friendly
8. **Keyboard Shortcuts**:
   - `Enter` to submit forms (already done)
   - `Escape` to close modals
9. **Dynamic Page Title**: `<title>PandaShare — {roomName}</title>`
10. **Favicon**: Update to panda-themed icon

### Validation
- Visual review on Chrome, Firefox, Safari
- Mobile viewport (375px width) — all content accessible
- Lighthouse score > 90 on Performance, Accessibility, Best Practices

---

## Step 15 — Testing

**Goal**: Automated and manual test coverage.

### Backend Tests
```bash
cd pandashare-backend && npm run test
```

Test suite:
- Room CRUD (create, read, expired room returns null)
- Room name uniqueness constraint
- File completion flow
- Storage service (upload/download roundtrip)
- Rate limiting behavior
- Validation errors

### Frontend Tests
```bash
cd pandashare-frontend && npm run test
```

Test suite:
- Crypto roundtrip: `encrypt → decrypt` produces identical buffer
- Upload pipeline: correctly chunks files
- Download pipeline: correctly reassembles files
- API client: handles errors gracefully

### E2E Manual Tests
| Test | Steps | Expected |
|------|-------|----------|
| Happy path (password) | Create room → Upload 10MB file → Copy link → Incognito → Enter password → Download | File identical, SHA-256 match |
| Happy path (public) | Create public room → Upload → Download via direct link | File identical |
| Wrong password | Try downloading with wrong password | Clear error: "Decryption failed" |
| Expired room | Wait for expiry (or set 1hr) | Room returns 404, "Room not found or expired" |
| Large file | Upload 500MB file | Memory stays stable, progress is smooth |
| Network error | Disconnect mid-upload | Error state on tile, retry button appears |

---

## Step 16 — Deployment & README

**Goal**: Production-ready deployment config and impressive documentation.

### Actions

1. **Root `docker-compose.yml`** — Full stack (frontend + backend + postgres + minio)
2. **Backend `Dockerfile`** — Multi-stage build
3. **Frontend `Dockerfile`** — Next.js standalone output
4. **Root `README.md`** — with:
   - Hero screenshot/banner
   - Tech stack badges
   - Feature highlights
   - Architecture diagram (mermaid)
   - Quick start guide
   - Security model explanation
   - Contributing guide
   - License

### Validation
- `docker-compose up` from root starts entire stack
- Full E2E flow works in containerized environment

---

## Key Decisions Log

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Database | PostgreSQL + Prisma | Relational model fits rooms→files hierarchy; Prisma gives type-safety; PostgreSQL is industry standard |
| Backend framework | Express | Most widely known; easy for reviewers to understand |
| S3 client | AWS SDK v3 | Official, well-maintained, works with MinIO via `forcePathStyle` |
| Chunk size | 5MB | Balance between memory usage and number of API calls |
| IV strategy | baseIV + chunkIndex XOR | Ensures unique IV per chunk with minimal overhead |
| Password transport | URL fragment only | Fragments are never sent to server (HTTP spec guarantee) |
| File assembly | In-memory Blob | Simple and works for files up to ~2GB. Streaming decryption is a v2 enhancement. |

---

## Dependency on Completion

```mermaid
graph LR
    S0["Step 0: Cleanup"] --> S1["Step 1: Backend Scaffold"]
    S1 --> S2["Step 2: Database"]
    S2 --> S3["Step 3: Docker"]
    S3 --> S4["Step 4: Room Routes"]
    S4 --> S5["Step 5: Storage Service"]
    S5 --> S6["Step 6: Upload Routes"]
    S5 --> S7["Step 7: Download Routes"]
    S6 --> S8["Step 8: Middleware"]
    S7 --> S8
    S8 --> S9["Step 9: Real API Client"]
    S9 --> S10["Step 10: Upload Pipeline"]
    S9 --> S11["Step 11: Download Pipeline"]
    S10 --> S12["Step 12: Wire to UI"]
    S11 --> S12
    S12 --> S13["Step 13: Routing"]
    S13 --> S14["Step 14: UX Polish"]
    S14 --> S15["Step 15: Testing"]
    S15 --> S16["Step 16: Deployment"]
```

> **Note**: Steps 10 and 11 can be done in parallel. Steps 6 and 7 can be done in parallel.
