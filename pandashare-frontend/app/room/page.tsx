"use client";

import React, { useEffect, useState } from "react";
import { getRoom, updateRoomExpiry, RoomMetadata } from "@/utils/api";
import { RoomFilesGrid } from "@/components/RoomFilesGrid";
import { Shield, Clock, Copy, Check } from "lucide-react";
import Link from "next/link";

export default function RoomPage() {
  const [roomId, setRoomId] = useState<string>("");
  const [room, setRoom] = useState<RoomMetadata | null>(null);
  const [loading, setLoading] = useState(true);

  // Saved password from URL
  const [localPassword, setLocalPassword] = useState<string>("");
  
  // Expiry state
  const [expiryHours, setExpiryHours] = useState<number>(24);
  const [isUpdatingExpiry, setIsUpdatingExpiry] = useState(false);
  const [showToast, setShowToast] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(window.location.href);
    setShowToast(true);
    setTimeout(() => setShowToast(false), 2500);
  };

  useEffect(() => {
    async function loadRoom() {
      // Auto-extract password and roomId from URL hash (#roomId,pass)
      let hash = "";
      if (typeof window !== "undefined" && window.location.hash) {
          hash = window.location.hash.substring(1); // remove '#'
      }
      
      if (!hash) {
          setLoading(false);
          return;
      }
      
      const commaIndex = hash.indexOf(",");
      let idOrName = hash;
      let urlPwd = "";
      if (commaIndex !== -1) {
          idOrName = hash.substring(0, commaIndex);
          urlPwd = hash.substring(commaIndex + 1);
      }
      
      setRoomId(idOrName);
      if (urlPwd) {
         setLocalPassword(urlPwd);
      }

      // Find room by Name or ID
      const data = await getRoom(idOrName);
      setRoom(data);
      
      // Calculate remaining hours if exists
      if (data) {
        const remainingMs = new Date(data.expiresAt).getTime() - Date.now();
        const hours = Math.round(remainingMs / (1000 * 60 * 60));
        setExpiryHours(hours > 0 ? hours : 24);
      }

      setLoading(false);
    }
    loadRoom();
    
    // Setup listener for hash changes just in case they navigate within the same page
    const handleHashChange = () => loadRoom();
    window.addEventListener("hashchange", handleHashChange);
    return () => window.removeEventListener("hashchange", handleHashChange);
  }, []);

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
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <div className="animate-pulse flex flex-col items-center">
           <Shield size={48} className="text-[#a1a1aa] mb-4" />
           <p className="text-[#a1a1aa]">Loading room environment...</p>
        </div>
      </div>
    );
  }

  if (!room) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[#0a0a0a] text-white font-mono">
        <div className="text-center space-y-4 border border-white/10 p-8 bg-[#0f0f0f] rounded-lg">
           <h1 className="text-3xl font-bold text-red-500">Room Not Found</h1>
           <p className="text-[#a1a1aa]">The room might have expired, or URL is invalid.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] font-sans selection:bg-white/20 p-4 sm:p-8">
      {/* Top Header */}
      <header className="flex flex-col sm:flex-row justify-between items-center mb-10 max-w-7xl mx-auto gap-4">
         <Link href="/" className="flex items-center space-x-2 hover:opacity-80 transition-opacity cursor-pointer text-white">
            <span className="font-mono text-2xl font-bold tracking-tight">pandashare</span>
         </Link>
         
         <button 
           onClick={handleCopy}
           className="bg-transparent border border-[#52525b] text-[#a1a1aa] hover:text-white hover:border-white rounded text-xs font-mono px-4 py-2 transition-all flex items-center space-x-2"
         >
           <Copy size={14} />
           <span>Copy</span>
         </button>
      </header>

      <main className="max-w-7xl mx-auto space-y-12">
         <div className="text-center space-y-2 mb-8">
            <h1 className="text-4xl font-bold font-mono tracking-tight text-white">{room.name}</h1>
            <div className="flex flex-wrap items-center justify-center gap-3 text-sm mt-3">
               <span className="bg-white/10 text-white border border-white/10 font-mono px-3 py-1 rounded-sm text-xs tracking-wide">
                 {room.mode.toUpperCase()} MODE
               </span>
               
               {/* Expiry Settings - available to everyone in this mode as requested */}
               <div className="flex items-center space-x-2 bg-[#121212] border border-white/10 font-mono text-[#a1a1aa] px-3 py-1.5 rounded-sm shadow-sm">
                  <Clock size={14} className={isUpdatingExpiry ? "animate-spin text-white" : ""} />
                  <span className="font-medium text-xs">Expires in:</span>
                  <select 
                    className="bg-transparent font-semibold outline-none cursor-pointer text-xs focus:ring-0 text-white"
                    value={expiryHours}
                    onChange={handleExpiryChange}
                    disabled={isUpdatingExpiry}
                  >
                     <option value={1} className="text-[#f4f4f5] bg-[#121212]">1 hour</option>
                     <option value={4} className="text-[#f4f4f5] bg-[#121212]">4 hours</option>
                     <option value={12} className="text-[#f4f4f5] bg-[#121212]">12 hours</option>
                     <option value={24} className="text-[#f4f4f5] bg-[#121212]">24 hours</option>
                     <option value={48} className="text-[#f4f4f5] bg-[#121212]">48 hours (Max)</option>
                  </select>
               </div>
            </div>
         </div>

         {/* Share view - Tiled Grid */}
         <div className="animate-in fade-in slide-in-from-bottom-4 duration-500">
            <RoomFilesGrid roomId={room.id} mode={room.mode} urlPassword={localPassword} />
         </div>
      </main>

      {/* Copy Toast */}
      {showToast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-foreground text-background px-4 py-2 rounded-full text-sm font-medium shadow-lg animate-in fade-in slide-in-from-bottom-4 duration-300 z-50 flex items-center space-x-2">
           <Check size={16} className="text-secondary" />
           <span>Link copied to clipboard</span>
        </div>
      )}
    </div>
  );
}
