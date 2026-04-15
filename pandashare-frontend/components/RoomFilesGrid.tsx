"use client";

import React, { useState, useRef } from "react";
import { Card, CardContent } from "./ui/Card";
import { Button } from "./ui/Button";
import { UploadCloud, File as FileIcon, Download, LockKeyhole, AlertCircle } from "lucide-react";

interface RoomFilesGridProps {
  roomId: string;
  mode: "password" | "public";
  urlPassword?: string;
}

interface FileTile {
  type: "file";
  id: string;
  name: string;
  size: string;
  status: "idle" | "decrypting" | "downloading" | "done" | "encrypting" | "uploading";
  progress: number;
}

export function RoomFilesGrid({ roomId, mode, urlPassword = "" }: RoomFilesGridProps) {
  const [password, setPassword] = useState(urlPassword);
  const [files, setFiles] = useState<FileTile[]>([
    { type: "file", id: "1", name: "secure_document.pdf", size: "2.4 MB", status: "idle", progress: 0 },
    { type: "file", id: "2", name: "archive.zip", size: "15.0 MB", status: "idle", progress: 0 },
  ]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleUploadClick = () => {
     fileInputRef.current?.click();
  };

  const handleUploadChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      const newFiles = Array.from(e.target.files).map((f) => ({
        type: "file" as const,
        id: Math.random().toString(),
        name: f.name,
        size: (f.size / 1024 / 1024).toFixed(2) + " MB",
        status: mode === "password" ? "encrypting" as const : "uploading" as const,
        progress: 0,
      }));
      setFiles((prev) => [...prev, ...newFiles]);

      // Simulate local encryption followed by chunked upload
      newFiles.forEach(async (f) => {
         const updateTile = (status: FileTile["status"], progress: number) => {
            setFiles(prev => prev.map(tile => tile.id === f.id ? { ...tile, status, progress } : tile));
         }

         if (mode === "password") {
           for (let i = 0; i <= 100; i += 25) {
             await new Promise(r => setTimeout(r, 150));
             updateTile("encrypting", i);
           }
         }
         
         updateTile("uploading", 0);
         for (let i = 0; i <= 100; i += 20) {
           await new Promise(r => setTimeout(r, 150));
           updateTile("uploading", i);
         }
         updateTile("done", 100);
         setTimeout(() => updateTile("idle", 0), 2000);
      });
    }
  };

  const [passwordPromptFile, setPasswordPromptFile] = useState<string | null>(null);
  const [tempPassword, setTempPassword] = useState("");
  const [decryptionError, setDecryptionError] = useState<string | null>(null);

  const handleDownload = async (fileId: string, pwdOverride?: string) => {
    const actPwd = pwdOverride || password;
    if (mode.toLowerCase() !== "public" && !actPwd) {
       setPasswordPromptFile(fileId);
       return;
    }

    if (pwdOverride) setPassword(pwdOverride);

    const updateTile = (status: FileTile["status"], progress: number) => {
       setFiles(prev => prev.map(f => f.id === fileId ? { ...f, status, progress } : f));
    }

    if (mode === "password") {
       updateTile("decrypting", 0);
       for (let i = 0; i <= 100; i += 20) {
         await new Promise(r => setTimeout(r, 200));
         updateTile("decrypting", i);
       }
    }

    updateTile("downloading", 0);
    for (let i = 0; i <= 100; i += 15) {
      await new Promise(r => setTimeout(r, 150));
      updateTile("downloading", i);
    }

    updateTile("done", 100);
    setTimeout(() => {
       updateTile("idle", 0);
    }, 2000);
  };

  const handlePasswordSubmit = () => {
     if (!passwordPromptFile || !tempPassword.trim()) return;
     
     // Mock error for testing UX resilience against faulty decrypts (e.g. typing "fail")
     if (tempPassword.trim() === "fail") {
        setDecryptionError("Incorrect or corrupted decryption key. Please try again.");
        return;
     }

     setDecryptionError(null);
     const fileId = passwordPromptFile;
     setPasswordPromptFile(null);
     handleDownload(fileId, tempPassword.trim());
  };

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(240px,1fr))] gap-6">
      {/* Upload Tile */}
      <Card 
         className="flex flex-col items-center justify-center p-6 border-2 border-dashed border-white/20 hover:border-white hover:bg-white/5 cursor-pointer bg-[#0f0f0f] text-white transition-all min-h-[240px] rounded-lg font-mono"
         onClick={handleUploadClick}
      >
        <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleUploadChange}
        />
        <UploadCloud size={48} className="text-primary mb-4" />
        <p className="font-semibold text-center text-sm">Upload File</p>
        <p className="text-xs text-muted-foreground text-center mt-1">Click or Drag & Drop</p>
      </Card>

      {/* File Tiles */}
      {files.map(f => (
         <Card key={f.id} className="flex flex-col justify-between p-5 bg-[#0f0f0f] border border-white/10 min-h-[240px] rounded-lg hover:border-white/30 transition-all font-mono text-white">
            <div className="flex items-start justify-between mb-4">
               <div className="p-2 bg-white/10 border border-white/10 text-white rounded flex-shrink-0">
                 <FileIcon size={24} />
               </div>
               {mode === "password" && <LockKeyhole size={16} className="text-muted-foreground opacity-50" />}
            </div>
            
            <div className="flex-1 overflow-hidden min-h-0">
               <p className="font-semibold text-sm truncate" title={f.name}>{f.name}</p>
               <p className="text-xs text-muted-foreground mt-1">{f.size}</p>
            </div>

            <div className="mt-4">
               {f.status === "idle" || f.status === "done" ? (
                 <Button 
                   variant="secondary" 
                   size="sm" 
                   className="w-full flex justify-center items-center space-x-2 text-xs h-9 bg-transparent border border-[#52525b] hover:border-white hover:text-white text-[#a1a1aa] rounded transition-all"
                   onClick={() => handleDownload(f.id)}
                 >
                   <Download size={14} />
                   <span>{mode === "password" ? "Decrypt & Download" : "Download"}</span>
                 </Button>
               ) : (
                 <div className="space-y-2">
                    <div className="flex justify-between text-[10px] text-[#a1a1aa] uppercase tracking-widest font-semibold">
                       <span>{f.status}</span>
                       <span>{f.progress}%</span>
                    </div>
                    <div className="w-full bg-white/10 rounded-sm h-1.5 overflow-hidden">
                      <div 
                          className="bg-white h-1.5 rounded-sm transition-all duration-300"
                          style={{ width: `${f.progress}%` }}
                      />
                    </div>
                 </div>
               )}
            </div>
         </Card>
      ))}
      </div>

      {/* Password Prompt Modal */}
      {passwordPromptFile && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 font-mono">
          <div className="w-full max-w-sm border border-white/10 bg-[#0f0f0f] text-white rounded-lg animate-in fade-in zoom-in-95 duration-200">
             <div className="p-6 space-y-4">
                <div className="flex items-center space-x-2 text-[#f4f4f5]">
                   <LockKeyhole size={20} />
                   <h3 className="font-bold text-lg">Encrypted File</h3>
                </div>
                <p className="text-sm text-[#a1a1aa]">
                  Please enter the room password to decrypt and download this file securely.
                </p>

                {decryptionError && (
                   <div className="p-2 bg-red-500/10 text-red-500 border border-red-500/20 rounded flex items-center space-x-2">
                       <AlertCircle size={14} />
                       <span className="text-xs font-semibold">{decryptionError}</span>
                   </div>
                )}

                <div className="pt-2">
                   <input
                      type="password"
                      className="flex h-10 w-full rounded-md border border-white/10 bg-[#1a1a1a] px-3 py-2 text-sm text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 font-mono transition-colors"
                      placeholder="Room Password"
                      value={tempPassword}
                      onChange={e => setTempPassword(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && handlePasswordSubmit()}
                      autoFocus
                   />
                </div>
                <div className="flex justify-end space-x-3 pt-4">
                   <button 
                     className="px-4 py-2 text-sm text-[#a1a1aa] hover:text-white transition-colors" 
                     onClick={() => { setPasswordPromptFile(null); setTempPassword(""); setDecryptionError(null); }}
                   >
                     Cancel
                   </button>
                   <button 
                     className="px-4 py-2 text-sm bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors"
                     onClick={handlePasswordSubmit}
                   >
                     Unlock
                   </button>
                </div>
             </div>
          </div>
        </div>
      )}
    </>
  );
}
