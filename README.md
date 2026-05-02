# PandaShare

**Secure, encrypted file & text sharing platform**

🔐 End-to-end encrypted | 🚀 Fast & lightweight | 📁 Multi-file support | 🔒 Password-protected | ⏱️ Auto-expiring links

**Live Demo:** https://www.pandashare.space/

---

## Features

### 🔒 Security First
- **End-to-End Encryption**: AES-256-GCM encryption with PBKDF2 key derivation
- **Client-Side Only**: Encryption/decryption happens entirely in your browser — PandaShare never sees plaintext
- **Zero-Knowledge**: No master keys, no backdoors — only you control access
- **Secure Password Mode**: Optional password protection with constant-time verification

### 📤 Smart Upload
- **Multipart Uploads**: Large files (up to 2GB) uploaded directly to S3 in parallel
- **Real-Time Progress**: Smooth, granular progress tracking even during 5MB+ chunks
- **Resume Support**: Automatic retry with exponential backoff on network failures
- **Zero Buffering**: Data streams directly to S3 — no Node.js buffering

### 📁 Flexible Sharing
- **File Rooms**: Share multiple files with a single link
- **Text Snippets**: Quick code/text sharing with auto-expiry
- **Public Mode**: Instant sharing, no password needed
- **Private Mode**: Password-protected rooms for sensitive data

### ⏱️ Auto-Cleanup
- **Automatic Expiry**: Rooms & files expire after configurable hours
- **S3 Auto-Deletion**: Expired files deleted from S3 every 15 minutes
- **Log Retention**: System logs kept for 3 days, then auto-purged
- **Admin Control**: Manual expiry options for rooms/snippets before cleanup cycle

### 📊 Admin Dashboard
- **Real-Time Monitoring**: View all active rooms and snippets
- **Manual Cleanup**: Expire rooms/snippets on-demand
- **Structured Logs**: JSON logs with filtering by level (INFO/WARN/ERROR)
- **Pagination**: Browse large log files efficiently

---

## Tech Stack

### Frontend
- **Next.js 15** - React framework
- **TypeScript** - Type safety
- **Tailwind CSS** - Styling
- **Web Crypto API** - Client-side encryption
- **Lucide React** - Icons
- **Sonner** - Toast notifications

### Backend
- **Express.js** - REST API
- **Node.js 18+** - Runtime
- **PostgreSQL** - Database
- **Prisma ORM** - Type-safe database access
- **AWS S3 v3** - Object storage
- **Vitest** - Unit testing

### Deployment
- **Vercel** - Frontend hosting
- **AWS S3** - File storage
- **Supabase PostgreSQL** - Database

---

## Quick Start

### Development

#### Backend
```bash
cd pandashare-backend
npm install
npm run dev
```

Backend runs on `http://localhost:4000`

#### Frontend
```bash
cd pandashare-frontend
npm install
npm run dev
```

Frontend runs on `http://localhost:3000`

### Environment Variables

**Backend** (`.env`):
```env
DATABASE_URL=postgresql://user:password@localhost/pandashare
S3_ENDPOINT=http://localhost:9000
S3_ACCESS_KEY=minioadmin
S3_SECRET_KEY=minioadmin
S3_BUCKET=pandashare
ADMIN_PASSWORD=your-secure-password
LOG_RETENTION_DAYS=3
```

**Frontend** (`.env.local`):
```env
NEXT_PUBLIC_API_URL=http://localhost:4000
```

### Testing

```bash
cd pandashare-backend
npm run test
```

All tests pass: ✅ 7/7 cleanup tests | ✅ 25/25 storage tests

---

## Architecture

### Security Model

1. **Key Derivation**: Password → PBKDF2(SHA-256, 100k iterations) → AES-256 key
2. **Encryption**: AES-256-GCM with unique IV per chunk
3. **IV Generation**: `baseIV + chunkIndex` ensures unique IVs without overhead
4. **Authentication**: GCM provides built-in authentication tag

### Storage Model

Three S3 storage patterns for optimal performance:

- **Public Files**: `public/{roomId}/{fileId}` (single object, no encryption)
- **Encrypted Chunks**: `encrypted/{roomId}/{fileId}.{chunkIndex}` (per-chunk storage)
- **Multipart Objects**: Direct S3 multipart upload (large files, minimal S3 requests)

### Cleanup Strategy

- **15-minute cycle**: Runs every 15 minutes to delete expired rooms/snippets
- **S3 + DB deletion**: First deletes S3 files, then database records
- **Atomic per-room**: Each room deletion succeeds/fails independently
- **Log rotation**: Old logs auto-deleted based on `LOG_RETENTION_DAYS`

---

## API Routes

### Public Routes

```
POST   /api/rooms                          - Create a room
GET    /api/rooms/{id}                     - Get room metadata
GET    /api/rooms/{id}/files               - Get files (password-protected)
POST   /api/snippets                       - Create a text snippet
GET    /api/snippets/{id}                  - Get snippet metadata
GET    /api/snippets/{id}/content          - Get snippet content
POST   /api/upload/...                     - Multipart upload endpoints
POST   /api/download/...                   - Download presigned URLs
```

### Admin Routes (Password-Protected)

```
GET    /api/admin/rooms                    - List all rooms
POST   /api/admin/rooms/{id}/expire        - Expire a room
POST   /api/admin/rooms/expire-all         - Expire all rooms
GET    /api/admin/snippets                 - List all snippets
POST   /api/admin/snippets/{id}/expire     - Expire a snippet
POST   /api/admin/snippets/expire-all      - Expire all snippets
GET    /api/admin/logs                     - List log files
GET    /api/admin/logs/{filename}          - Read log file (paginated)
```

---

## Contributing

Contributions welcome! Areas for improvement:

- [ ] Custom expiry times (currently 15 min cleanup cycle)
- [ ] Bulk file operations
- [ ] Email notifications
- [ ] Rate limiting per IP/device
- [ ] Image preview on download
- [ ] Download history/analytics

---

## License

This project is licensed under the MIT License - see [LICENSE](LICENSE) file for details.

---

## Deployment

### Frontend (Vercel)
1. Push to GitHub
2. Connect repo to Vercel
3. Set `NEXT_PUBLIC_API_URL` environment variable
4. Deploy

### Backend (Self-Hosted or VPS)
1. Set all `.env` variables
2. Run `npm run build` then `npm start`
3. Ensure PostgreSQL and S3 are accessible

---

## Support

Found a bug? Have a feature request?

- 📧 Email: vikasdbhat@gmail.com
- 🐛 Issues: GitHub Issues
- 💬 Discussions: GitHub Discussions

---

**Made with ❤️ by VBD**
