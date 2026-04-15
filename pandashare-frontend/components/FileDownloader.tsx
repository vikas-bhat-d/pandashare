"use client";

import React, { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "./ui/Card";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Download, File as FileIcon, LockKeyhole, AlertTriangle } from "lucide-react";

interface FileDownloaderProps {
  roomId: string;
  mode: "password" | "public";
  initialPassword?: string;
}

export function FileDownloader({ roomId, mode, initialPassword = "" }: FileDownloaderProps) {
  const [password, setPassword] = useState(initialPassword);
  const [isUnlocked, setIsUnlocked] = useState(mode.toLowerCase() === "public");
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);

  // Mock list of files in the room
  const availableFiles = [
    { id: "1", name: "secure_document.pdf", size: "2.4 MB" },
    { id: "2", name: "archive.zip", size: "15.0 MB" },
  ];

  const handleUnlock = () => {
    if (password.length > 0) {
      // In a real app we would attempt to derive the key and test it against a stored MAC or chunk
      setIsUnlocked(true);
    }
  };

  const handleDownload = async (fileName: string) => {
    setIsDownloading(true);
    setDownloadProgress(0);

    // Simulate download and decryption process
    for (let i = 0; i <= 100; i += 15) {
      await new Promise(r => setTimeout(r, 200));
      setDownloadProgress(Math.min(i, 100));
    }
    
    setIsDownloading(false);
    setDownloadProgress(100);
    setTimeout(() => setDownloadProgress(0), 2000);
    // In a real app we'd trigger the File System Access API here
    console.log("Triggered download stream saving for", fileName);
  };

  if (!isUnlocked) {
    return (
      <div className="w-full max-w-md mx-auto border border-white/10 bg-[#0f0f0f] rounded-lg shadow-xl text-white font-mono">
        <div className="text-center p-6 border-b border-white/10">
          <div className="flex justify-center mb-4">
            <div className="p-4 bg-white/10 border border-white/10 rounded flex-shrink-0 text-[#f4f4f5]">
              <LockKeyhole size={32} />
            </div>
          </div>
          <h3 className="text-xl font-bold mb-2">Unlock Room</h3>
          <p className="text-sm text-[#a1a1aa]">
            This room is end-to-end encrypted. You need the password to view and download files.
          </p>
        </div>
        <div className="p-6 space-y-4">
          <div className="space-y-2">
            <input
              type="password"
              placeholder="Enter room password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="w-full bg-[#1a1a1a] border border-white/10 rounded-md py-3 text-center text-lg text-white placeholder:text-[#52525b] focus:outline-none focus:border-white/30 transition-colors"
              onKeyDown={(e) => {
                  if (e.key === "Enter") handleUnlock();
              }}
            />
          </div>
        </div>
        <div className="p-6 pt-0">
          <button 
            className="w-full py-3 bg-white text-black font-semibold rounded hover:bg-gray-200 transition-colors disabled:opacity-50"
            onClick={handleUnlock}
            disabled={password.length === 0}
          >
            Decrypt Files
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="w-full max-w-xl mx-auto border border-white/10 bg-[#0f0f0f] rounded-lg shadow-xl text-white font-mono">
      <div className="p-6 border-b border-white/10">
        <div className="flex items-center space-x-2 text-lg font-bold">
          {mode === "password" ? <LockKeyhole className="text-[#a1a1aa]" /> : <AlertTriangle className="text-red-500" />}
          <h3>Available Files</h3>
        </div>
        <p className="text-sm text-[#a1a1aa] mt-2">
          {mode === "password" 
            ? "Files will be decrypted locally in your browser during download." 
            : "Warning: These files are public and not encrypted."}
        </p>
      </div>
      <div className="p-6">
        <div className="space-y-3">
          {availableFiles.map((f) => (
            <div key={f.id} className="flex flex-col p-4 border border-white/10 rounded-lg bg-[#121212] hover:border-white/30 transition-all">
              <div className="flex items-center justify-between">
                 <div className="flex items-center space-x-3">
                  <div className="p-2 bg-white/10 text-white rounded border border-white/10">
                    <FileIcon size={24} />
                  </div>
                  <div>
                    <p className="font-semibold text-sm">{f.name}</p>
                    <p className="text-xs text-[#a1a1aa]">{f.size}</p>
                  </div>
                 </div>
                 <button 
                   className="flex items-center space-x-2 text-xs bg-transparent border border-[#52525b] hover:border-white hover:text-white text-[#a1a1aa] px-3 py-2 rounded transition-all disabled:opacity-50"
                   onClick={() => handleDownload(f.name)}
                   disabled={isDownloading && downloadProgress > 0 && downloadProgress < 100}
                 >
                   <Download size={14} />
                   <span>Download</span>
                 </button>
              </div>
              {isDownloading && downloadProgress > 0 && downloadProgress < 100 && (
                  <div className="mt-4 space-y-1">
                      <div className="flex justify-between text-xs text-[#a1a1aa] uppercase tracking-widest font-semibold">
                          <span>{mode === "password" ? "Downloading & Decrypting..." : "Downloading..."}</span>
                          <span>{downloadProgress}%</span>
                      </div>
                      <div className="w-full bg-white/10 rounded-sm h-1">
                        <div 
                            className="bg-white h-1 rounded-sm transition-all duration-300"
                            style={{ width: `${downloadProgress}%` }}
                        ></div>
                      </div>
                  </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
