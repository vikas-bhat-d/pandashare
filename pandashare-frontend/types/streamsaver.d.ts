declare module "streamsaver" {
  interface CreateWriteStreamOptions {
    size?: number;
    writableStrategy?: QueuingStrategy;
    readableStrategy?: QueuingStrategy;
  }

  function createWriteStream(
    filename: string,
    options?: CreateWriteStreamOptions
  ): WritableStream<Uint8Array>;

  let mitm: string;
  let WritableStream: typeof globalThis.WritableStream;
  let TransformStream: typeof globalThis.TransformStream;
}
