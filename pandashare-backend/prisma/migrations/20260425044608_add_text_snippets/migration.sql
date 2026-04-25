-- CreateTable
CREATE TABLE "TextSnippet" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "RoomMode" NOT NULL,
    "content" TEXT NOT NULL,
    "salt" TEXT,
    "baseIV" TEXT,
    "verifier" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TextSnippet_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TextSnippet_name_key" ON "TextSnippet"("name");

-- CreateIndex
CREATE INDEX "TextSnippet_name_idx" ON "TextSnippet"("name");

-- CreateIndex
CREATE INDEX "TextSnippet_expiresAt_idx" ON "TextSnippet"("expiresAt");
