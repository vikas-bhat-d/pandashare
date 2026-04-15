"use client";

import React, { useEffect, useState } from "react";
import { useParams, useSearchParams } from "next/navigation";
import { getRoom, updateRoomExpiry, RoomMetadata } from "@/utils/api";
import { FileUploader } from "@/components/FileUploader";
import { FileDownloader } from "@/components/FileDownloader";
import { Shield, Settings, Server, Eye, Clock } from "lucide-react";
import { Toggle } from "@/components/ui/Toggle";

export default function RoomPage() {
  const { id } = useParams() as { id: string };
  const searchParams = useSearchParams();
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  // Demo toggle to switch between uploader (host) and downloader (guest) views
  const [isHostView, setIsHostView] = useState(true);

  // Saved password if the current user created the room or from URL
  const [localPassword, setLocalPassword] = useState<string | undefined>();
  
  // Expiry state
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [isUpdatingExpiry, setIsUpdatingExpiry] = useState(false);

  useEffect(() => {
    async function loadRoom() {
      // Find room by Name or ID
      const data = await getRoom(id);
      setRoom(data);
      
      // Calculate remaining hours if exists
      if (data) {
        const remainingMs = new Date(data.expiresAt).getTime() - Date.now();
        const hours = Math.round(remainingMs / (1000 * 60 * 60));
        setExpiryHours(hours > 0 ? hours : 24);
      }

      setLoading(false);
      
      // Auto-extract password from URL search params (?pwd=xxx) or hash (#xxx)
      let urlPwd = searchParams.get("pwd") || searchParams.get("password");
      if (!urlPwd && typeof window !== "undefined" && window.location.hash) {
          urlPwd = window.location.hash.substring(1); // remove '#'
      }

      const storedPwd = sessionStorage.getItem(`room_pwd_${id}`) || (data ? sessionStorage.getItem(`room_pwd_${data.id}`) : null);
      
      if (urlPwd) {
         setLocalPassword(urlPwd);
         // If they have URL pwd, default to guest view first (they just got a link)
         if (!storedPwd) {
            setIsHostView(false); 
         }
      } else if (storedPwd) {
         setLocalPassword(storedPwd);
         setIsHostView(true); // default to host if they have the password saved locally from creation
      } else {
         setIsHostView(false); // default to guest
      }
    }
    loadRoom();
  }, [id, searchParams]);

  const handleExpiryChange = async (e: React.ChangeEvent<HTMLSelectElement>) => {
      const newHours = parseInt(e.target.value);
      if (!room) return;
      setExpiryHours(newHours);
      setIsUpdatingExpiry(true);
      await updateRoomExpiry(room.id, newHours);
      setIsUpdatingExpiry(false);
      setRoom({
          ...room,
          expiresAt: new Date(Date.now() + newHours * 60 * 60 * 1000).toISOString()
      });
  };

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="animate-pulse flex flex-col items-center">
           <Shield size={48} className="text-muted-foreground/30 mb-4" />
           <p className="text-muted-foreground">Loading room environment...</p>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="text-center space-y-4">
           <h1 className="text-3xl font-bold text-destructive">Room Not Found</h1>
           <p className="text-muted-foreground">The room might have expired or does not exist.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-br from-background via-muted/10 to-accent/5 p-4 sm:p-8">
      {/* Top Header */}
      <header className="flex flex-col sm:flex-row justify-between items-center mb-10 max-w-5xl mx-auto gap-4">
         <div className="flex items-center space-x-2">
            <Shield size={24} className="text-primary" />
            <span className="font-bold text-lg tracking-tight">PandaShare</span>
         </div>
         
         {/* Demo View Switcher */}
         <div className="flex items-center space-x-3 bg-card px-4 py-2 rounded-full border shadow-sm">
            <span className="text-xs font-medium text-muted-foreground flex items-center space-x-1">
               {isHostView ? <Server size={14}/> : <Eye size={14}/>}
               <span>Demo Mode: {isHostView ? "Host" : "Guest"}</span>
            </span>
            <Toggle checked={isHostView} onCheckedChange={setIsHostView} />
         </div>
      </header>

      <main className="max-w-5xl mx-auto space-y-8">
         <div className="text-center space-y-2 mb-12">
            <h1 className="text-4xl font-extrabold tracking-tight">{room.name}</h1>
            <div className="flex flex-wrap items-center justify-center gap-3 text-sm mt-3">
               <span className="bg-primary/10 text-primary px-3 py-1 rounded text-xs font-semibold tracking-wide">
                 {room.mode.toUpperCase()} MODE
               </span>
               
               {/* Expiry Settings - visible to host */}
               {isHostView ? (
                 <div className="flex items-center space-x-2 bg-secondary/10 px-3 py-1 rounded-md text-secondary-foreground border border-secondary/20">
                    <Clock size={14} className={isUpdatingExpiry ? "animate-spin" : ""} />
                    <span className="font-medium text-xs">Expires in:</span>
                    <select 
                      className="bg-transparent font-semibold outline-none cursor-pointer text-xs"
                      value={expiryHours}
                      onChange={handleExpiryChange}
                      disabled={isUpdatingExpiry}
                    >
                       <option value={1} className="text-foreground">1 hour</option>
                       <option value={4} className="text-foreground">4 hours</option>
                       <option value={12} className="text-foreground">12 hours</option>
                       <option value={24} className="text-foreground">24 hours</option>
                       <option value={48} className="text-foreground">48 hours (Max)</option>
                    </select>
                 </div>
               ) : (
                 <span className="text-muted-foreground flex items-center space-x-1">
                   <Clock size={14} />
                   <span>Expires in {expiryHours} hours</span>
                 </span>
               )}
            </div>
         </div>

         {/* Render UI based on Demo View */}
         <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            {isHostView ? (
               <div className="space-y-6">
                 <FileUploader roomId={room.id} mode={room.mode} encryptionKey={localPassword} />
               </div>
            ) : (
               <FileDownloader roomId={room.id} mode={room.mode} initialPassword={localPassword} />
            )}
         </div>
      </main>
    </div>
  );
}
