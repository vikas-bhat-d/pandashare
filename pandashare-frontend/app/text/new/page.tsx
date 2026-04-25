"use client";
// This route is no longer used. The text page handles creation directly.
// Redirect preserving the hash so old links still work.
import { useEffect } from "react";
import { useRouter } from "next/navigation";

export default function NewSnippetRedirect() {
  const router = useRouter();
  useEffect(() => {
    // Move the hash (which contains name|password) to /text/
    router.replace("/text/" + window.location.hash);
  }, [router]);
  return null;
}
