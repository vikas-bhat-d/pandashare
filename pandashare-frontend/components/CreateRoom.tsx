"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "./ui/Card";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import { Toggle } from "./ui/Toggle";
import { ShieldCheck, ArrowRight, Key } from "lucide-react";
import { generateRoomName } from "@/utils/crypto";
import { createRoom, getRoom } from "@/utils/api";

export function CreateRoom() {
  const router = useRouter();
  const [roomName, setRoomName] = useState("");
  const [password, setPassword] = useState("");
  const [isEncrypted, setIsEncrypted] = useState(true);
  const [isLoading, setIsLoading] = useState(false);

  useEffect(() => {
    setRoomName(generateRoomName());
  }, []);

  const handleGo = async () => {
    if (!roomName.trim()) return;
    setIsLoading(true);
    try {
      // Auto-detect if room exists
      const existingRoom = await getRoom(roomName.trim());
      
      if (existingRoom) {
         // Join room logic
         const pwdString = password.trim() ? `,${password.trim()}` : "";
         router.push(`/room/#${existingRoom.name || existingRoom.id}${pwdString}`);
      } else {
         // Create room logic
         const mode = isEncrypted ? "password" : "public";
         
         const newRoom = await createRoom({
           name: roomName.trim(),
           mode: mode,
         });

         // Redirect to Room with name and password in hash
         const hashSuffix = isEncrypted && password.trim() ? `,${password.trim()}` : "";
         router.push(`/room/#${newRoom.name}${hashSuffix}`);
      }
    } catch (e) {
      console.error(e);
      alert("Failed to access room.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card className="w-full max-w-md mx-auto shadow-2xl border-none ring-1 ring-white/10">
      <CardHeader className="text-center pb-2 pt-8">
        <div className="flex justify-center mb-4">
          <div className="p-4 bg-primary/10 rounded-full text-primary shadow-inner">
            <ShieldCheck size={40} />
          </div>
        </div>
        <CardTitle className="text-2xl font-bold tracking-tight">Enter PandaShare</CardTitle>
        <CardDescription>
          Type a room name to join an existing session, or create a brand new one instantly.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6 pt-4">
        {/* Room Name Input */}
        <div className="space-y-2">
          <Input
            value={roomName}
            onChange={(e) => setRoomName(e.target.value)}
            placeholder="e.g. Brave-Panda-402"
            className="font-mono bg-background/50 text-center text-lg h-14"
            onKeyDown={(e) => {
               if (e.key === "Enter") handleGo();
            }}
          />
        </div>

        {/* Encryption Toggle */}
        <div className="flex items-center justify-between px-2 pt-2">
          <div className="space-y-0.5">
            <p className="text-sm font-medium">Secure Delivery Mode</p>
            <p className="text-xs text-muted-foreground">
              Encrypts new files locally
            </p>
          </div>
          <Toggle checked={isEncrypted} onCheckedChange={setIsEncrypted} />
        </div>

        {/* Password Input */}
        {isEncrypted && (
          <div className="space-y-2 animate-in fade-in slide-in-from-top-4 duration-300">
            <div className="flex items-center space-x-2 text-sm font-medium text-foreground/80 px-2">
               <Key size={14} />
               <label>Room Password</label>
            </div>
            <Input
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="Leave blank to join without password, or type to create/join securely"
              className="font-mono bg-background/50"
              onKeyDown={(e) => {
                 if (e.key === "Enter") handleGo();
              }}
            />
          </div>
        )}

      </CardContent>
      <CardFooter className="pb-8">
        <Button 
          className="w-full text-md h-12 shadow-md hover:shadow-lg transition-all flex items-center space-x-2" 
          onClick={handleGo}
          disabled={isLoading || !roomName.trim()}
        >
          <span>{isLoading ? "Connecting..." : "Go"}</span>
          {!isLoading && <ArrowRight size={18} />}
        </Button>
      </CardFooter>
    </Card>
  );
}
