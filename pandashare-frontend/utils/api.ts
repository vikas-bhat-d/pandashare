// api.ts - Mock services to simulate a backend for PandasShare

export interface RoomMetadata {
    id: string;
    name: string;
    mode: "password" | "public";
    salt?: string; // base64
    baseIV?: string; // base64
    createdAt: string;
    expiresAt: string;
}

// Temporary in-memory store for mocked backend
const MOCK_DB: Record<string, RoomMetadata> = {};

export async function createRoom(data: Omit<RoomMetadata, "id" | "createdAt" | "expiresAt">): Promise<RoomMetadata> {
    const id = Math.random().toString(36).substring(2, 9);
    const room: RoomMetadata = {
        ...data,
        id,
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString() // 24 hours
    };
    MOCK_DB[id] = room;
    
    // Simulate network delay
    await new Promise(r => setTimeout(r, 800));
    return room;
}

export async function getRoom(idOrName: string): Promise<RoomMetadata | null> {
    await new Promise(r => setTimeout(r, 500));
    try {
        idOrName = decodeURIComponent(idOrName);
    } catch(e) {}
    
    if (MOCK_DB[idOrName]) return MOCK_DB[idOrName];
    // Find by name
    let found = Object.values(MOCK_DB).find(r => r.name === idOrName);
    
    if (!found && idOrName) {
        // Auto-generate room for mock testing if the state was lost due to a page refresh
        found = {
            id: Math.random().toString(36).substring(2, 9),
            name: idOrName,
            mode: "password",
            createdAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString()
        };
        MOCK_DB[found.id] = found;
    }
    
    return found || null;
}

export async function updateRoomExpiry(id: string, newExpiryHours: number): Promise<void> {
    await new Promise(r => setTimeout(r, 200));
    if (MOCK_DB[id]) {
        MOCK_DB[id].expiresAt = new Date(Date.now() + newExpiryHours * 60 * 60 * 1000).toISOString();
    }
}

// --------------------------------------------------------------------------------
// Mocking the Chunk Upload API endpoints to ensure easy swap to real backend later
// --------------------------------------------------------------------------------

export async function uploadChunk(
    roomId: string, 
    fileId: string, 
    chunkIndex: number, 
    chunk: ArrayBuffer
): Promise<void> {
    // Edge case: In a real app we would use fetch with method POST and body as generic arraybuffer/formdata.
    // fetch(`/api/upload/${roomId}/${fileId}/${chunkIndex}`, { method: 'POST', body: chunk })
    await new Promise(r => setTimeout(r, 50)); 
}

export async function completeUpload(roomId: string, fileId: string): Promise<void> {
    // fetch(`/api/complete/${roomId}`, { method: 'POST', body: JSON.stringify({ fileId }) })
    await new Promise(r => setTimeout(r, 200));
}

// --------------------------------------------------------------------------------
// Mocking the Download API endpoints
// --------------------------------------------------------------------------------

export async function getDownloadChunk(roomId: string, fileId: string, chunkIndex: number): Promise<ArrayBuffer> {
    // fetch(`/api/download/${roomId}/${fileId}/${chunkIndex}`) -> return arraybuffer
    await new Promise(r => setTimeout(r, 50));
    return new ArrayBuffer(0); // Mock empty data
}

export async function getPresignedUrl(roomId: string, fileId: string): Promise<string> {
    // fetch(`/api/file/${roomId}/${fileId}/url`)
    await new Promise(r => setTimeout(r, 200));
    return `https://mock-s3-bucket.com/public/${roomId}/${fileId}?expires=12345`;
}

export function toBase64(buffer: ArrayBuffer | Uint8Array): string {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return window.btoa(binary);
}

export function fromBase64(base64: string): Uint8Array {
    const binary_string = window.atob(base64);
    const len = binary_string.length;
    const bytes = new Uint8Array(len);
    for (let i = 0; i < len; i++) {
        bytes[i] = binary_string.charCodeAt(i);
    }
    return bytes;
}
