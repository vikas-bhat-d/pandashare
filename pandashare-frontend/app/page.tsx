"use client";

import React, { useState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { generateRoomName, generateSalt, generateBaseIV, computeVerifier } from "@/utils/crypto";
import { createRoom, getRoom, toBase64 } from "@/utils/api";
import { Terminal, ShieldCheck, ShieldOff, ExternalLink, AlertCircle } from "lucide-react";
import { toast } from "sonner";

export default function Home() {
  const router = useRouter();
  const [roomName, setRoomName] = useState("");
  const [password, setPassword] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"server" | "webrtc">("server");
  const [isEncrypted, setIsEncrypted] = useState(true);

  useEffect(() => {
    setRoomName(generateRoomName());
  }, []);

  const handleGo = async () => {
    if (!roomName.trim()) return;
    setIsLoading(true);
    try {
      const existingRoom = await getRoom(roomName.trim());
      if (existingRoom) {
         const pwdString = existingRoom.mode === "password" && password.trim()
           ? `|${encodeURIComponent(password.trim())}`
           : "";
         router.push(`/room/#${encodeURIComponent(existingRoom.name || existingRoom.id)}${pwdString}`);
      } else {
         // Generate crypto params for password-mode rooms
         let salt: string | undefined;
         let baseIV: string | undefined;
         let verifier: string | undefined;

         if (isEncrypted) {
           const saltBytes = await generateSalt();
           const ivBytes = await generateBaseIV();
           salt = toBase64(saltBytes);
           baseIV = toBase64(ivBytes);
           if (password.trim()) {
             verifier = await computeVerifier(roomName.trim().toLowerCase(), password.trim());
           }
         }

         const newRoom = await createRoom({
           name: roomName.trim(),
           mode: isEncrypted ? "password" : "public",
           salt,
           baseIV,
           verifier,
         });
         const hashSuffix = isEncrypted && password.trim() ? `|${encodeURIComponent(password.trim())}` : "";
         router.push(`/room/#${encodeURIComponent(newRoom.name)}${hashSuffix}`);
      }
    } catch (e) {
      console.error(e);
      toast.error("Failed to access room. Please check your connection.");
    } finally {
      setIsLoading(false);
    }
  };


  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#f4f4f5] font-mono selection:bg-white/20 flex flex-col">
      {/* Navbar */}
      <nav className="flex items-center justify-between px-6 py-4 border-b border-white/5">
        <div className="text-2xl font-bold tracking-tight flex items-center">
          <span className="text-white">pandashare</span>
        </div>
        <div className="hidden md:flex items-center gap-6 text-sm text-[#a1a1aa]">
          <a href="https://github.com/vikas-bhat-d/pandashare" target="_blank" rel="noopener noreferrer" className="hover:text-white transition-colors flex items-center gap-1.5">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z"/></svg>
            <span>GitHub</span>
          </a>
        </div>
      </nav>

      {/* Main Content */}
      <main className="flex-1 max-w-4xl mx-auto mt-24 px-6 flex flex-col items-start text-left pb-20">
        {/* Hero Text */}
        <h1 className="text-5xl sm:text-6xl font-bold tracking-tight mb-8">
          The open source <br className="hidden sm:block" /> file sharing platform
        </h1>
        
        <p className="text-[#a1a1aa] text-lg mb-12 leading-relaxed">
          Share files of any size quickly with your peers.<br className="hidden sm:block" />
          High-grade, client-side encryption ensures your data remains secure.
        </p>

        {/* Input Box mimicking terminal */}
        <div className="w-full max-w-3xl rounded-lg border border-white/10 bg-transparent overflow-hidden mb-20">
          {/* Box Header - tabs */}
          <div className="flex items-center px-4 pt-3 pb-0 border-b border-white/10 bg-[#121212]">
             <div className="flex space-x-6 text-sm text-[#a1a1aa]">
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
          <div className="p-6 bg-[#0f0f0f] border-x border-b border-white/10 rounded-b-lg flex flex-col gap-4 min-h-[104px]">
             {activeTab === "server" ? (
               <div className="flex flex-col gap-4 w-full">
                 {/* Room name + Go button row */}
                 <div className="flex flex-col sm:flex-row gap-4 w-full items-center justify-between">
                   <div className="flex-1 flex flex-col sm:flex-row gap-4 w-full text-sm">
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
                      {/* Password input — only when encryption is ON */}
                      {isEncrypted && (
                        <div className="relative flex-1 animate-in fade-in slide-in-from-top-2 duration-200">
                           <input 
                             type="password" 
                             value={password}
                             onChange={(e) => setPassword(e.target.value)}
                             className="w-full bg-[#1a1a1a] border border-white/5 rounded-md py-3 px-4 text-white focus:outline-none focus:border-white/20 focus:ring-1 focus:ring-white/20 transition-all placeholder:text-[#52525b]"
                             placeholder="Password (optional)"
                             onKeyDown={(e) => e.key === "Enter" && handleGo()}
                           />
                        </div>
                      )}
                   </div>
                   
                   <button 
                     onClick={handleGo}
                     disabled={isLoading || !roomName}
                     className="w-full sm:w-auto self-stretch flex items-center justify-center bg-transparent border border-[#52525b] text-[#a1a1aa] px-6 py-3 rounded-md font-medium hover:text-white hover:border-white transition-colors disabled:opacity-50"
                   >
                     {isLoading ? "Connecting" : "Go"}
                   </button>
                 </div>

                 {/* Encryption toggle row */}
                 <div className="flex items-center justify-between pt-2 border-t border-white/5">
                    <button
                      onClick={() => setIsEncrypted(!isEncrypted)}
                      className="flex items-center gap-2 text-xs text-[#a1a1aa] hover:text-white transition-colors group"
                    >
                      {isEncrypted ? (
                        <ShieldCheck size={14} className="text-emerald-500" />
                      ) : (
                        <ShieldOff size={14} className="text-amber-500" />
                      )}
                      <span>
                        {isEncrypted ? "End-to-end encryption enabled" : "Encryption disabled — files are public"}
                      </span>
                    </button>
                    {/* Toggle switch */}
                    <button
                      onClick={() => setIsEncrypted(!isEncrypted)}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                        isEncrypted ? "bg-emerald-600" : "bg-[#52525b]"
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform ${
                          isEncrypted ? "translate-x-4" : "translate-x-0.5"
                        }`}
                      />
                    </button>
                 </div>

                 {/* Public mode warning */}
                 {!isEncrypted && (
                   <div className="flex items-center gap-2 text-xs text-amber-400/80 bg-amber-500/5 border border-amber-500/10 rounded px-3 py-2 animate-in fade-in slide-in-from-top-2 duration-200">
                     <AlertCircle size={14} className="shrink-0" />
                     Files will not be encrypted. Anyone with the room link can access them.
                   </div>
                 )}
               </div>
             ) : (
               <div className="w-full flex items-center justify-center py-2 text-[#a1a1aa] text-sm">
                 <span className="flex items-center gap-2">
                   <Terminal size={16} className="text-[#52525b]" />
                   <span>WebRTC Peer-to-Peer mode is currently under development. Check back later!</span>
                 </span>
               </div>
             )}
          </div>
        </div>

        {/* Bottom context similar to image */}
        <div className="w-full max-w-3xl rounded-lg border border-white/10 bg-[#0f0f0f] overflow-hidden flex flex-col sm:flex-row text-xs text-[#52525b]">
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

      {/* Footer */}
      <footer className="border-t border-white/5 py-6 px-6">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row items-center justify-between gap-4 text-xs text-[#52525b]">
          <span>PandaShare — Zero-knowledge file sharing</span>
          <div className="flex items-center gap-4">
            <span>AES-256-GCM</span>
            <span>•</span>
            <span>PBKDF2</span>
            <span>•</span>
            <span>Web Crypto API</span>
          </div>
        </div>
      </footer>
    </div>
  );
}
