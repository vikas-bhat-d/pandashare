"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { generateRoomName } from "@/utils/crypto";
import { createRoom, getRoom } from "@/utils/api";
import { Download, Terminal } from "lucide-react";

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"server" | "webrtc">("server");

  useEffect(() => {
    setRoomName(generateRoomName());
  }, []);

  const handleGo = async () => {
    if (!roomName.trim()) return;
    setIsLoading(true);
    try {
      const existingRoom = await getRoom(roomName.trim());
      if (existingRoom) {
         const pwdString = password.trim() ? `,${password.trim()}` : "";
         router.push(`/room/#${existingRoom.name || existingRoom.id}${pwdString}`);
      } else {
         const newRoom = await createRoom({
           name: roomName.trim(),
           mode: password.trim() ? "password" : "public",
         });
         const hashSuffix = password.trim() ? `,${password.trim()}` : "";
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
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] font-sans selection:bg-white/20 pb-20">
      {/* Navbar segment */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="font-mono text-2xl font-bold tracking-tight flex items-center">
          <span className="text-white">pandashare</span>
        </div>
        <div className="hidden md:flex items-center gap-6 text-sm text-[#a1a1aa] font-mono">
          <a href="#" className="hover:text-white transition-colors">GitHub</a>
        </div>
      </nav>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto mt-24 px-6 flex flex-col items-start text-left">
        {/* Hero Text */}
        <h1 className="text-5xl sm:text-6xl font-bold font-mono tracking-tight mb-8">
          The open source <br className="hidden sm:block" /> file sharing platform
        </h1>
        
        <p className="text-[#a1a1aa] font-mono text-lg mb-12 leading-relaxed">
          Share files of any size quickly with your peers.<br className="hidden sm:block" />
          High-grade, client-side encryption ensures your data remains secure.
        </p>

        {/* Input Box mimicking terminal */}
        <div className="w-full max-w-3xl rounded-lg border border-white/10 bg-transparent overflow-hidden mb-20">
          {/* Box Header - tabs */}
          <div className="flex items-center px-4 pt-3 pb-0 border-b border-white/10 bg-[#121212]">
             <div className="flex space-x-6 text-sm font-mono text-[#a1a1aa]">
                <button 
                  onClick={() => setActiveTab("server")}
                  className={`relative pb-3 transition-colors ${activeTab === "server" ? "text-white" : "hover:text-white"}`}
                >
                   <span className="relative z-10">Client-Server</span>
                   {activeTab === "server" && <span className="absolute bottom-0 left-0 right-0 h-[1px] bg-white"></span>}
                </button>
                <button 
                  onClick={() => setActiveTab("webrtc")}
                  className={`relative pb-3 transition-colors ${activeTab === "webrtc" ? "text-white" : "hover:text-white"}`}
                >
                   <span className="relative z-10">Peer-to-Peer</span>
                   {activeTab === "webrtc" && <span className="absolute bottom-0 left-0 right-0 h-[1px] bg-white"></span>}
                </button>
             </div>
          </div>
          
          {/* Box Input Area */}
          <div className="p-6 bg-[#0f0f0f] border-x border-b border-white/10 rounded-b-lg flex flex-col sm:flex-row gap-4 items-center justify-center min-h-[104px] group">
             {activeTab === "server" ? (
               <div className="flex flex-col sm:flex-row gap-4 w-full items-center justify-between">
                 <div className="flex-1 flex flex-col sm:flex-row gap-4 w-full font-mono text-sm">
                    <div className="relative flex-1">
                       <div className="absolute inset-y-0 left-0 flex items-center pl-3 text-[#52525b] pointer-events-none">
                          <Terminal size={16} />
                       </div>
                       <input 
                         type="text" 
                         value={roomName}
                         onChange={(e) => setRoomName(e.target.value)}
                         className="w-full bg-[#1a1a1a] border border-white/5 rounded-md py-3 pl-10 pr-4 text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 transition-all placeholder:text-[#52525b]"
                         placeholder="Room code"
                       />
                    </div>
                    <div className="relative flex-1">
                       <input 
                         type="password" 
                         value={password}
                         onChange={(e) => setPassword(e.target.value)}
                         className="w-full bg-[#1a1a1a] border border-white/5 rounded-md py-3 px-4 text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 transition-all placeholder:text-[#52525b]"
                         placeholder="Password (optional)"
                         onKeyDown={(e) => e.key === "Enter" && handleGo()}
                       />
                    </div>
                 </div>
                 
                 <button 
                   onClick={handleGo}
                   disabled={isLoading || !roomName}
                   className="w-full sm:w-auto self-stretch flex items-center justify-center bg-transparent border border-[#52525b] text-[#a1a1aa] px-6 py-3 rounded-md font-mono font-medium hover:text-white hover:border-white transition-colors disabled:opacity-50"
                 >
                   {isLoading ? "Connecting" : "Go"}
                 </button>
               </div>
             ) : (
               <div className="w-full flex items-center justify-center py-2 text-[#a1a1aa] font-mono text-sm">
                 <span className="flex items-center gap-2">
                   <Terminal size={16} className="text-[#52525b]" />
                   <span>WebRTC Peer-to-Peer mode is currently under development. Check back later!</span>
                 </span>
               </div>
             )}
          </div>
        </div>

        {/* Bottom context similar to image */}
        <div className="w-full max-w-3xl rounded-lg border border-white/10 bg-[#0f0f0f] overflow-hidden flex flex-col sm:flex-row text-xs font-mono text-[#52525b]">
           <div className="p-4 sm:border-r border-white/10 flex-[2] whitespace-pre-wrap leading-relaxed">
{`> Establishing secure end-to-end tunnel...
> Generating cryptographic keys...
> Connected to nearest relay node
> Ready to send and receive files`}
           </div>
           <div className="p-4 flex-1 bg-black/20 flex flex-col justify-center">
              <div className="mb-4 text-white">E2EE Tunnel<br/>Active</div>
              <div>Context</div>
              <div>256-bit AES</div>
              <div>100% Secure</div>
           </div>
        </div>
      </main>
    </div>
  );
}
