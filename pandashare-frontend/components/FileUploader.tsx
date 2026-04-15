"use client";

import React, { useState, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle, CardFooter } from "./ui/Card";
import { Button } from "./ui/Button";
import { UploadCloud, File as FileIcon, X, CheckCircle2, Lock } from "lucide-react";

interface FileUploaderProps {
  roomId: string;
  mode: "password" | "public";
  encryptionKey?: string; // Optional raw password, normally used to derive key if needed
}

interface UploadingFile {
  name: string;
  size: number;
  progress: number;
  status: "pending" | "encrypting" | "uploading" | "done" | "error";
}

export function FileUploader({ roomId, mode, encryptionKey }: FileUploaderProps) {
  const [files, setFiles] = useState<UploadingFile[]>([]);
  const [isDragActive, setIsDragActive] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleDrag = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setIsDragActive(true);
    } else if (e.type === "dragleave") {
      setIsDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      handleFiles(Array.from(e.dataTransfer.files));
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    e.preventDefault();
    if (e.target.files && e.target.files[0]) {
      handleFiles(Array.from(e.target.files));
    }
  };

  const handleFiles = (newFiles: File[]) => {
    const toUpload = newFiles.map(f => ({
      name: f.name,
      size: f.size,
      progress: 0,
      status: "pending" as const
    }));
    setFiles(prev => [...prev, ...toUpload]);

    // Simulate upload process for each file
    toUpload.forEach((file, index) => {
      simulateUpload(files.length + index, file.name);
    });
  };

  const simulateUpload = async (index: number, name: string) => {
    // This is where real crypto and chunked upload logic would go
    // For now, it's simulated visually
    
    const updateFile = (progress: number, status: UploadingFile["status"]) => {
      setFiles(prev => {
        const next = [...prev];
        if (next[index]) {
          next[index] = { ...next[index], progress, status };
        }
        return next;
      });
    };

    if (mode === "password") {
      updateFile(0, "encrypting");
      // Simulate encryption time
      for (let i = 0; i <= 100; i += 20) {
        await new Promise(r => setTimeout(r, 200));
        updateFile(i, "encrypting");
      }
    }

    updateFile(0, "uploading");
    for (let i = 0; i <= 100; i += 10) {
      await new Promise(r => setTimeout(r, 150));
      updateFile(i, "uploading");
    }

    updateFile(100, "done");
  };

  const removeFile = (index: number) => {
    setFiles(prev => prev.filter((_, i) => i !== index));
  };

  return (
    <Card className="w-full max-w-2xl mx-auto shadow-xl border-dashed border-2 hover:border-primary/50 transition-colors bg-card/60 backdrop-blur-sm">
      <CardHeader>
        <CardTitle className="flex items-center space-x-2 text-xl">
          <UploadCloud className="text-secondary" />
          <span>Upload Files to Room</span>
        </CardTitle>
        <CardDescription>
          {mode === "password" ? 
            <span className="flex items-center space-x-1 text-primary gap-1">
              <Lock size={14} /> 
              <span>Files will be encrypted locally before upload</span>
            </span> 
            : 
            <span className="text-destructive">Public mode: Files are NOT encrypted.</span>
          }
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div
          onDragEnter={handleDrag}
          onDragLeave={handleDrag}
          onDragOver={handleDrag}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          className={`flex flex-col items-center justify-center w-full h-48 border-2 border-dashed rounded-lg cursor-pointer transition-all ${
            isDragActive ? "border-primary bg-primary/5" : "border-muted-foreground/20 bg-muted/20"
          }`}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={handleChange}
          />
          <UploadCloud size={48} className={`mb-3 ${isDragActive ? "text-primary" : "text-muted-foreground"}`} />
          <p className="mb-2 text-sm text-foreground/80 font-semibold">
            <span className="text-primary hover:underline">Click to upload</span> or drag and drop
          </p>
          <p className="text-xs text-muted-foreground">Any file size (up to max limit)</p>
        </div>

        {files.length > 0 && (
          <div className="mt-8 space-y-4">
            <h4 className="font-semibold text-sm">Upload Queue</h4>
            {files.map((file, i) => (
              <div key={i} className="flex items-center justify-between p-3 border rounded-md bg-background/50">
                <div className="flex items-center space-x-3 w-full pr-4">
                  <div className="p-2 bg-accent/30 rounded text-accent-foreground">
                    <FileIcon size={20} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{file.name}</p>
                    <div className="flex items-center justify-between text-xs text-muted-foreground mt-1 mb-1">
                      <span>{(file.size / 1024 / 1024).toFixed(2)} MB</span>
                      <span>{file.status === "encrypting" ? "Encrypting..." : (file.status === "uploading" ? "Uploading..." : file.status === "done" ? "Complete" : file.status)}</span>
                    </div>
                    {/* Progress bar */}
                    <div className="w-full bg-secondary/20 rounded-full h-1.5 overflow-hidden">
                      <div 
                        className={`h-1.5 rounded-full transition-all duration-300 ${
                            file.status === "encrypting" ? "bg-primary animate-pulse" : 
                            file.status === "done" ? "bg-secondary" : "bg-primary"
                        }`}
                        style={{ width: `${file.progress}%` }}
                      ></div>
                    </div>
                  </div>
                </div>
                {file.status === "done" ? (
                  <CheckCircle2 className="text-secondary shrink-0" size={20} />
                ) : (
                  <Button variant="ghost" size="icon" onClick={() => removeFile(i)} className="shrink-0 h-8 w-8 text-muted-foreground">
                    <X size={16} />
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
